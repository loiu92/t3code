import * as NodeServices from "@effect/platform-node/NodeServices";
import { VcsProcessExitError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../config.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubAttachmentResolver from "./GitHubAttachmentResolver.ts";

const ATTACHMENT_URL =
  "https://github.com/user-attachments/assets/0b1f6f2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const SIGNED_URL =
  "https://github-production-user-asset-6210df.s3.amazonaws.com/1/2.png?X-Amz-Expires=300&X-Amz-Signature=abc";

interface RecordedRequest {
  readonly url: string;
  readonly authorization: string | undefined;
}

function makeResolverLayer(options: {
  readonly token: string | null;
  readonly respond: () => Response;
}) {
  const ghCalls: Array<ReadonlyArray<string>> = [];
  const requests: RecordedRequest[] = [];
  const vcsProcessLayer = Layer.succeed(VcsProcess.VcsProcess, {
    run: (input) => {
      ghCalls.push(input.args);
      if (options.token === null) {
        return Effect.fail(
          new VcsProcessExitError({
            operation: input.operation,
            command: input.command,
            cwd: input.cwd,
            exitCode: 1,
            detail: "not logged in",
            failureKind: "authentication",
          }),
        );
      }
      return Effect.succeed({
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout: `${options.token}\n`,
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    },
  });
  const httpClientLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push({ url: request.url, authorization: request.headers.authorization });
        return HttpClientResponse.fromWeb(request, options.respond());
      }),
    ),
  );
  const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-github-attachment-test-",
  });
  const layer = GitHubAttachmentResolver.layer.pipe(
    Layer.provide(GitHubCli.layer),
    Layer.provide(vcsProcessLayer),
    Layer.provide(httpClientLayer),
    Layer.provide(configLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  return { layer, ghCalls, requests };
}

const redirectTo = (location: string) => () =>
  new Response(null, { status: 302, headers: { location } });

describe("GitHubAttachmentResolver", () => {
  it.effect("sends the gh token and returns the signed redirect target", () => {
    const { layer, ghCalls, requests } = makeResolverLayer({
      token: "ghp_test",
      respond: redirectTo(SIGNED_URL),
    });
    return Effect.gen(function* () {
      const resolver = yield* GitHubAttachmentResolver.GitHubAttachmentResolver;
      expect(yield* resolver.resolve(ATTACHMENT_URL)).toBe(SIGNED_URL);
      expect(ghCalls).toEqual([["auth", "token", "--hostname", "github.com"]]);
      expect(requests).toEqual([{ url: ATTACHMENT_URL, authorization: "token ghp_test" }]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads the token once for a body full of attachments", () => {
    const { layer, ghCalls, requests } = makeResolverLayer({
      token: "ghp_test",
      respond: redirectTo(SIGNED_URL),
    });
    return Effect.gen(function* () {
      const resolver = yield* GitHubAttachmentResolver.GitHubAttachmentResolver;
      yield* resolver.resolve(ATTACHMENT_URL);
      yield* resolver.resolve(`${ATTACHMENT_URL}2`);
      expect(ghCalls).toHaveLength(1);
      expect(requests).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("asks anonymously when gh has no token", () => {
    const { layer, requests } = makeResolverLayer({ token: null, respond: redirectTo(SIGNED_URL) });
    return Effect.gen(function* () {
      const resolver = yield* GitHubAttachmentResolver.GitHubAttachmentResolver;
      expect(yield* resolver.resolve(ATTACHMENT_URL)).toBe(SIGNED_URL);
      expect(requests).toEqual([{ url: ATTACHMENT_URL, authorization: undefined }]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("yields nothing when GitHub answers with a page instead of a redirect", () => {
    const { layer } = makeResolverLayer({
      token: "ghp_test",
      respond: () => new Response("Not Found", { status: 404 }),
    });
    return Effect.gen(function* () {
      const resolver = yield* GitHubAttachmentResolver.GitHubAttachmentResolver;
      expect(yield* resolver.resolve(ATTACHMENT_URL)).toBeNull();
    }).pipe(Effect.provide(layer));
  });

  it.effect("yields nothing for a redirect that is not https", () => {
    const { layer } = makeResolverLayer({
      token: "ghp_test",
      respond: redirectTo("http://example.com/asset.png"),
    });
    return Effect.gen(function* () {
      const resolver = yield* GitHubAttachmentResolver.GitHubAttachmentResolver;
      expect(yield* resolver.resolve(ATTACHMENT_URL)).toBeNull();
    }).pipe(Effect.provide(layer));
  });
});
