import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const SearchResultSchema = z.array(z.object({ url: z.url() }));
const SEARCH_LIMIT = "1000";
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

async function searchPullRequestUrls(filter: "author" | "review-requested"): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "gh",
    ["search", "prs", `--${filter}=@me`, "--state=open", `--limit=${SEARCH_LIMIT}`, "--json=url"],
    {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  );
  return SearchResultSchema.parse(JSON.parse(stdout)).map(({ url }) => url);
}

export async function resolveViewerScope({ urls }: { urls: string[] }) {
  const requested = new Set(urls.map((url) => url.toLowerCase()));
  try {
    const [authored, reviewRequested] = await Promise.all([
      searchPullRequestUrls("author"),
      searchPullRequestUrls("review-requested"),
    ]);
    return {
      authoredUrls: authored.filter((url) => requested.has(url.toLowerCase())),
      reviewRequestedUrls: reviewRequested.filter((url) => requested.has(url.toLowerCase())),
      error: null,
    };
  } catch (error) {
    return {
      authoredUrls: [],
      reviewRequestedUrls: [],
      error: error instanceof Error ? error.message : "GitHub viewer scope is unavailable.",
    };
  }
}
