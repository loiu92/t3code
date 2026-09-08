import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";

const GITHUB_HOST = "github.com";
const TOKEN_CACHE_TTL = Duration.minutes(5);
const RESOLVE_TIMEOUT = Duration.seconds(15);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Turns a GitHub upload link into the time-limited download GitHub answers a
 * signed-in reader with. Only the redirect target is read; the bytes go from
 * GitHub's storage straight to the client.
 */
export class GitHubAttachmentResolver extends Context.Service<
  GitHubAttachmentResolver,
  {
    /** The signed download URL, or `null` when GitHub refuses or answers with a page. */
    readonly resolve: (url: string) => Effect.Effect<string | null>;
  }
>()("t3/assets/GitHubAttachmentResolver") {}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const github = yield* GitHubCli.GitHubCli;
  const httpClient = yield* HttpClient.HttpClient;

  // `gh` owns the credential, so login state and GH_TOKEN keep working as they do for
  // every other GitHub call. Cached so a body full of screenshots does not spawn one
  // process per image. Without a token the request goes out anonymously, which is
  // what a public repository needs and what a private one already failed with.
  const token = yield* github
    .execute({ cwd: config.stateDir, args: ["auth", "token", "--hostname", GITHUB_HOST] })
    .pipe(
      Effect.map((output) => output.stdout.trim() || null),
      Effect.orElseSucceed(() => null),
      Effect.cachedWithTTL(TOKEN_CACHE_TTL),
    );

  const resolve = Effect.fn("GitHubAttachmentResolver.resolve")(function* (url: string) {
    const authorization = yield* token;
    return yield* httpClient
      .get(url, {
        headers: authorization === null ? {} : { authorization: `token ${authorization}` },
      })
      .pipe(
        Effect.map((response) => {
          const location = response.headers.location?.trim();
          return REDIRECT_STATUSES.has(response.status) &&
            location !== undefined &&
            isHttpsUrl(location)
            ? location
            : null;
        }),
        Effect.scoped,
        Effect.timeoutOption(RESOLVE_TIMEOUT),
        Effect.map(Option.getOrNull),
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to resolve a GitHub attachment.", { url, cause }),
        ),
        Effect.orElseSucceed(() => null),
        // The signed target is on another host and following it would download the file.
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      );
  });

  return GitHubAttachmentResolver.of({ resolve });
});

export const layer = Layer.effect(GitHubAttachmentResolver, make);
