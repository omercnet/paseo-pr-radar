import type { PluginContext } from "@getpaseo/plugin";
import { PrRadar } from "./src/components/pr-radar.client";
import { resolveViewerScope } from "./src/lib/viewer-scope.server";
import { viewerScope } from "./src/lib/viewer-scope.shared";

export default function contribute(plugin: PluginContext) {
  plugin.handle(viewerScope, resolveViewerScope);
  plugin.addSurface("radar", PrRadar);
  plugin.addSidebarItem({
    id: "radar",
    title: "PR Radar",
    icon: "GitPullRequest",
    surface: "radar",
  });
  plugin.addCommandCenterItem({
    id: "open-radar",
    title: "Open PR Radar",
    icon: "GitPullRequest",
    keywords: ["pull requests", "delivery", "merge", "agents"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("radar");
    },
  });
  return () => {};
}
