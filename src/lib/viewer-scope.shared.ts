import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

export const viewerScope = defineRpc({
  name: "pr-radar.viewer-scope",
  input: z.object({
    urls: z.array(z.url()).max(200),
  }),
  output: z.object({
    authoredUrls: z.array(z.url()),
    reviewRequestedUrls: z.array(z.url()),
    error: z.string().nullable(),
  }),
});
