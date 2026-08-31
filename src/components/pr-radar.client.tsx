import type { PaseoApi, PaseoWorkspace } from "@getpaseo/client";
import { type PluginSurfaceProps, usePaseo, useRpc } from "@getpaseo/plugin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  type AgentEntry,
  agentActionFor,
  applyViewerScope,
  BUCKET_TITLES,
  BUCKETS,
  buildAgentPrompt,
  buildRadarSnapshot,
  checkSummary,
  formatAge,
  matchesRow,
  type RadarBucket,
  type RadarRow,
} from "../lib/radar.shared";
import { viewerScope } from "../lib/viewer-scope.shared";

const PAGE_LIMIT = 200;
const MAX_PAGES = 10;
const BACKSTOP_REFRESH_MS = 60_000;
const EVENT_DEBOUNCE_MS = 500;
const CLOCK_TICK_MS = 30_000;

async function loadAgents(paseo: PaseoApi): Promise<AgentEntry[]> {
  const entries: AgentEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await paseo.agents.list({
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    entries.push(...result.entries);
    cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
    if (!cursor) break;
  }
  return entries;
}

async function loadWorkspaces(paseo: PaseoApi): Promise<PaseoWorkspace[]> {
  const workspaces: PaseoWorkspace[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await paseo.workspaces.list({
      page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    workspaces.push(...result.entries);
    cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
    if (!cursor) break;
  }
  return workspaces;
}

function bucketColor(bucket: RadarBucket, colors: PluginSurfaceProps["theme"]["colors"]): string {
  if (bucket === "needs-you") return colors.statusDanger;
  if (bucket === "ready") return colors.statusSuccess;
  if (bucket === "being-handled") return colors.accent;
  return colors.statusWarning;
}

function agentState(row: RadarRow): string {
  const agent = row.agents[0];
  if (!agent) return "No active agent";
  const extra = row.agents.length > 1 ? ` +${row.agents.length - 1}` : "";
  if (agent.pendingPermissions > 0) return `${agent.title} · permission${extra}`;
  if (agent.requiresAttention && agent.attentionReason !== "finished") {
    return `${agent.title} · needs input${extra}`;
  }
  return `${agent.title} · ${agent.status}${extra}`;
}

export function PrRadar({ theme, layout, host, navigation }: PluginSurfaceProps) {
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["pr-radar", host.id], [host.id]);
  const resolveViewerScope = useRpc(viewerScope);
  const [selected, setSelected] = useState<RadarBucket | null>(null);
  const [search, setSearch] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [openError, setOpenError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const {
    data,
    error,
    isPending,
    isFetching: isDirectoryFetching,
    refetch,
  } = useQuery({
    queryKey,
    queryFn: async () => {
      const [workspaces, agents] = await Promise.all([loadWorkspaces(paseo), loadAgents(paseo)]);
      return buildRadarSnapshot(workspaces, agents);
    },
    refetchInterval: BACKSTOP_REFRESH_MS,
  });

  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(clock);
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const invalidate = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void queryClient.invalidateQueries({ queryKey });
      }, EVENT_DEBOUNCE_MS);
    };
    const unsubscribeAgents = paseo.agents.subscribe(invalidate);
    const unsubscribeWorkspaces = paseo.workspaces.subscribe(invalidate);
    return () => {
      clearTimeout(timer);
      unsubscribeAgents();
      unsubscribeWorkspaces();
    };
  }, [paseo, queryClient, queryKey]);

  const rawRows = data?.rows ?? [];
  const scopeUrls = useMemo(() => rawRows.map((row) => row.url), [rawRows]);
  const {
    data: viewerData,
    error: viewerQueryError,
    isFetching: isViewerFetching,
    refetch: refetchViewer,
  } = useQuery({
    queryKey: ["pr-radar-viewer-scope", host.id, scopeUrls],
    queryFn: () => resolveViewerScope({ urls: scopeUrls }),
    enabled: scopeUrls.length > 0,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });
  const rows = useMemo(() => applyViewerScope(rawRows, viewerData ?? null), [rawRows, viewerData]);
  const isFetching = isDirectoryFetching || isViewerFetching;
  const viewerError =
    viewerData?.error ??
    (viewerQueryError instanceof Error
      ? viewerQueryError.message
      : viewerQueryError
        ? "error"
        : null);
  const agentMutation = useMutation({
    mutationFn: async (row: RadarRow) => {
      const action = agentActionFor(row);
      if (!action) throw new Error("No agent action is available for this pull request.");
      const prompt = buildAgentPrompt(row);
      if (action.kind === "ask") {
        await paseo.agents.ref(action.agentId).send(prompt);
        return `Asked an agent to handle ${row.repository}#${row.number ?? "PR"}.`;
      }

      const { config } = await paseo.config.get();
      const profiles = config.agentProfiles ?? [];
      const profile =
        profiles.find((candidate) => candidate.name.toLowerCase() === "model router") ??
        profiles[0];
      if (!profile) {
        throw new Error("Configure an agent profile in Paseo before starting an agent.");
      }
      const provider = profile.model ? `${profile.provider}/${profile.model}` : profile.provider;
      const created = await paseo.workspaces.ref(action.workspaceId).agents.create({
        config: {
          provider,
          ...(profile.modeId ? { modeId: profile.modeId } : {}),
          ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}),
          ...(profile.featureValues ? { featureValues: profile.featureValues } : {}),
        },
        title: `PR Radar: ${row.repository}#${row.number ?? "PR"}`,
        prompt,
      });
      navigation?.openAgent({ agentId: created.id });
      return `Started ${profile.name} for ${row.repository}#${row.number ?? "PR"}.`;
    },
    onMutate: () => {
      setOpenError(null);
      setActionNotice(null);
    },
    onSuccess: (message) => {
      setActionNotice(message);
    },
    onError: (mutationError) => {
      setOpenError(
        mutationError instanceof Error ? mutationError.message : "Could not contact an agent.",
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
  const counts = useMemo(() => {
    const result: Record<RadarBucket, number> = {
      "needs-you": 0,
      ready: 0,
      "being-handled": 0,
      waiting: 0,
    };
    for (const row of rows) result[row.bucket] += 1;
    return result;
  }, [rows]);
  const visibleRows = useMemo(
    () => rows.filter((row) => (!selected || row.bucket === selected) && matchesRow(row, search)),
    [rows, search, selected],
  );

  const styles = useMemo(() => {
    const gutter = layout.compact ? 14 : 24;
    const mutedBorder = `${theme.colors.foregroundMuted}35`;
    return {
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { paddingBottom: 32 },
      header: { paddingHorizontal: gutter, paddingTop: gutter, paddingBottom: 14, gap: 14 },
      eyebrow: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        fontWeight: "700" as const,
        letterSpacing: 1.5,
      },
      heroRow: {
        flexDirection: layout.compact ? ("column" as const) : ("row" as const),
        alignItems: layout.compact ? ("flex-start" as const) : ("flex-end" as const),
        gap: layout.compact ? 4 : 14,
      },
      heroNumber: {
        color: counts["needs-you"] > 0 ? theme.colors.statusDanger : theme.colors.statusSuccess,
        fontSize: layout.compact ? 44 : 56,
        fontWeight: "800" as const,
        lineHeight: layout.compact ? 48 : 58,
        letterSpacing: -2,
      },
      heroCopy: { flex: 1, gap: 2, paddingBottom: layout.compact ? 0 : 5 },
      heroTitle: { color: theme.colors.foreground, fontSize: 18, fontWeight: "700" as const },
      heroDetail: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18 },
      refresh: {
        minHeight: 36,
        justifyContent: "center" as const,
        paddingHorizontal: 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
      },
      refreshPressed: { opacity: 0.72 },
      refreshText: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 7 },
      chip: {
        minHeight: 32,
        justifyContent: "center" as const,
        paddingHorizontal: 10,
        borderWidth: 1,
        borderColor: mutedBorder,
        borderRadius: 16,
      },
      chipActive: {
        backgroundColor: theme.colors.foreground,
        borderColor: theme.colors.foreground,
      },
      chipText: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" as const },
      chipTextActive: { color: theme.colors.surface0 },
      search: {
        minHeight: 40,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        fontSize: 14,
      },
      warning: {
        marginHorizontal: gutter,
        marginBottom: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderLeftWidth: 3,
        borderLeftColor: theme.colors.statusWarning,
        backgroundColor: theme.colors.surface1,
      },
      warningText: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
      row: {
        flexDirection: "row" as const,
        marginHorizontal: gutter,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        minHeight: layout.compact ? 152 : 122,
      },
      rail: { width: 3, marginVertical: 14, borderRadius: 2 },
      rowBody: {
        flex: 1,
        paddingVertical: 14,
        paddingLeft: 12,
        gap: 6,
      },
      rowTop: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      identifier: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        fontWeight: "700" as const,
        letterSpacing: 0.4,
        textTransform: "uppercase" as const,
      },
      badge: {
        color: theme.colors.foregroundMuted,
        fontSize: 10,
        fontWeight: "700" as const,
        borderWidth: 1,
        borderColor: mutedBorder,
        borderRadius: 4,
        paddingHorizontal: 5,
        paddingVertical: 2,
      },
      title: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 15 : 16,
        fontWeight: "700" as const,
        lineHeight: 21,
      },
      reasonLine: { flexDirection: "row" as const, alignItems: "center" as const, gap: 7 },
      reasonDot: { width: 7, height: 7, borderRadius: 4 },
      reason: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      metadata: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
      actions: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingLeft: layout.compact ? 0 : 12,
        paddingTop: layout.compact ? 4 : 0,
      },
      action: {
        minHeight: 34,
        justifyContent: "center" as const,
        paddingHorizontal: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 7,
        backgroundColor: theme.colors.surface1,
      },
      actionPrimary: { borderColor: theme.colors.accent },
      actionAgent: {
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.accent,
      },
      actionAgentText: { color: theme.colors.accentForeground },
      actionDisabled: { opacity: 0.55 },
      actionText: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const },
      actionPrimaryText: { color: theme.colors.accent },
      empty: {
        paddingHorizontal: gutter,
        paddingVertical: 52,
        alignItems: "center" as const,
        gap: 8,
      },
      emptyTitle: { color: theme.colors.foreground, fontSize: 18, fontWeight: "700" as const },
      emptyDetail: {
        color: theme.colors.foregroundMuted,
        fontSize: 13,
        lineHeight: 19,
        textAlign: "center" as const,
        maxWidth: 420,
      },
      error: { color: theme.colors.statusDanger, fontSize: 13, lineHeight: 18 },
      notice: { color: theme.colors.statusSuccess, fontSize: 13, lineHeight: 18 },
      spinner: { marginVertical: 52 },
    };
  }, [counts, layout.compact, theme]);

  const openPr = useCallback(async (row: RadarRow) => {
    setOpenError(null);
    try {
      await Linking.openURL(row.url);
    } catch {
      setOpenError(`Could not open ${row.repository}#${row.number ?? "PR"}.`);
    }
  }, []);

  const renderRow = ({ item }: { item: RadarRow }) => {
    const color = bucketColor(item.bucket, theme.colors);
    const age = formatAge(item.activityAt, now);
    const primaryAgent = item.agents[0];
    const agentAction = agentActionFor(item);
    const actionPending = agentMutation.isPending && agentMutation.variables?.id === item.id;
    const ownershipLabel = item.reviewRequestedFromMe
      ? "REVIEW"
      : item.ownership === "mine"
        ? "YOURS"
        : item.ownership === "external"
          ? "EXTERNAL"
          : "SCOPE UNKNOWN";
    const actions = (
      <View style={styles.actions}>
        {agentAction ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${agentAction.kind === "ask" ? "Ask an agent to handle" : "Start an agent for"} ${item.repository} ${item.number ?? ""}`}
            accessibilityState={{ busy: actionPending, disabled: agentMutation.isPending }}
            disabled={agentMutation.isPending}
            onPress={() => agentMutation.mutate(item)}
            style={({ pressed }) => [
              styles.action,
              styles.actionAgent,
              (pressed || actionPending) && styles.refreshPressed,
              agentMutation.isPending && styles.actionDisabled,
            ]}
          >
            <Text style={[styles.actionText, styles.actionAgentText]}>
              {actionPending
                ? agentAction.kind === "ask"
                  ? "Sending…"
                  : "Starting…"
                : agentAction.kind === "ask"
                  ? "Ask agent"
                  : "Start agent"}
            </Text>
          </Pressable>
        ) : null}
        {navigation && primaryAgent ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open agent ${primaryAgent.title}`}
            onPress={() => navigation.openAgent({ agentId: primaryAgent.id })}
            style={({ pressed }) => [styles.action, pressed && styles.refreshPressed]}
          >
            <Text style={styles.actionText}>Open agent</Text>
          </Pressable>
        ) : null}
        {navigation && !primaryAgent && item.workspaceIds[0] ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open workspace for ${item.repository} ${item.number ?? ""}`}
            onPress={() => navigation.openWorkspace({ workspaceId: item.workspaceIds[0] })}
            style={({ pressed }) => [styles.action, pressed && styles.refreshPressed]}
          >
            <Text style={styles.actionText}>Open workspace</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`Open pull request ${item.repository} ${item.number ?? ""}`}
          onPress={() => void openPr(item)}
          style={({ pressed }) => [
            styles.action,
            styles.actionPrimary,
            pressed && styles.refreshPressed,
          ]}
        >
          <Text style={[styles.actionText, styles.actionPrimaryText]}>Open PR</Text>
        </Pressable>
      </View>
    );

    return (
      <View style={styles.row}>
        <View style={[styles.rail, { backgroundColor: color }]} />
        <View style={styles.rowBody}>
          <View style={styles.rowTop}>
            <Text style={styles.identifier} numberOfLines={1}>
              {item.repository}
              {item.number ? ` #${item.number}` : ""}
            </Text>
            <Text style={styles.badge}>{ownershipLabel}</Text>
            {item.isDraft ? <Text style={styles.badge}>DRAFT</Text> : null}
          </View>
          <Text style={styles.title} numberOfLines={2} ellipsizeMode="tail">
            {item.title}
          </Text>
          <View style={styles.reasonLine}>
            <View style={[styles.reasonDot, { backgroundColor: color }]} />
            <Text style={styles.reason}>{item.reason}</Text>
          </View>
          <Text style={styles.metadata} numberOfLines={1} ellipsizeMode="middle">
            {checkSummary(item)} · {item.headRefName} → {item.baseRefName}
          </Text>
          <Text style={styles.metadata} numberOfLines={1} ellipsizeMode="tail">
            {agentState(item)}
            {age ? ` · activity ${age} ago` : ""}
          </Text>
          {layout.compact ? actions : null}
        </View>
        {layout.compact ? null : actions}
      </View>
    );
  };

  const totalCopy = `${rows.length} open ${rows.length === 1 ? "pull request" : "pull requests"} across ${data?.workspaceCount ?? 0} workspaces`;
  const identityPending = scopeUrls.length > 0 && !viewerData && isViewerFetching;
  const clear = !identityPending && counts["needs-you"] === 0;
  const emptyCopy = search
    ? "No pull requests match this search."
    : selected
      ? `No pull requests are ${BUCKET_TITLES[selected].toLowerCase()}.`
      : "Paseo has not linked an open pull request to an active workspace yet.";

  const header = (
    <View style={styles.header}>
      <Text style={styles.eyebrow}>DELIVERY QUEUE</Text>
      <View style={styles.heroRow}>
        <Text style={styles.heroNumber}>
          {identityPending ? "·" : clear ? "✓" : counts["needs-you"]}
        </Text>
        <View style={styles.heroCopy}>
          <Text style={styles.heroTitle}>
            {identityPending
              ? "Resolving ownership"
              : clear
                ? "No unattended blockers"
                : "need your attention"}
          </Text>
          <Text style={styles.heroDetail}>{totalCopy}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh pull request status"
          accessibilityState={{ busy: isFetching }}
          disabled={isFetching}
          onPress={() => void Promise.all([refetch(), refetchViewer()])}
          style={({ pressed }) => [styles.refresh, pressed && styles.refreshPressed]}
        >
          <Text style={styles.refreshText}>{isFetching ? "Refreshing…" : "Refresh"}</Text>
        </Pressable>
      </View>
      <View accessibilityRole="tablist" style={styles.chips}>
        <Pressable
          accessibilityRole="tab"
          accessibilityState={{ selected: selected === null }}
          onPress={() => setSelected(null)}
          style={[styles.chip, selected === null && styles.chipActive]}
        >
          <Text style={[styles.chipText, selected === null && styles.chipTextActive]}>
            All {rows.length}
          </Text>
        </Pressable>
        {BUCKETS.map((bucket) => (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: selected === bucket }}
            key={bucket}
            onPress={() => setSelected(bucket)}
            style={[styles.chip, selected === bucket && styles.chipActive]}
          >
            <Text style={[styles.chipText, selected === bucket && styles.chipTextActive]}>
              {BUCKET_TITLES[bucket]} {counts[bucket]}
            </Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        accessibilityLabel="Filter pull requests"
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setSearch}
        placeholder="Filter by PR, branch, workspace, or agent"
        placeholderTextColor={theme.colors.foregroundMuted}
        style={styles.search}
        value={search}
      />
      {actionNotice ? <Text style={styles.notice}>{actionNotice}</Text> : null}
      {openError ? <Text style={styles.error}>{openError}</Text> : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error instanceof Error ? error.message : "Could not load the delivery queue."}
        </Text>
      ) : null}
      {viewerError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          GitHub viewer identity is unavailable. Action buckets are conservative.
        </Text>
      ) : null}
    </View>
  );

  return (
    <View style={styles.screen}>
      <FlatList
        contentContainerStyle={styles.content}
        data={visibleRows}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={header}
        ListEmptyComponent={
          isPending ? (
            <ActivityIndicator color={theme.colors.accent} style={styles.spinner} />
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>
                {rows.length === 0 ? "Clear runway" : "Nothing here"}
              </Text>
              <Text style={styles.emptyDetail}>{emptyCopy}</Text>
            </View>
          )
        }
        renderItem={renderRow}
      />
      {data?.warnings.length ? (
        <View style={styles.warning}>
          <Text style={styles.warningText} numberOfLines={2}>
            {data.warnings.length}{" "}
            {data.warnings.length === 1 ? "workspace has" : "workspaces have"} unavailable pull
            request status. Other results are current.
          </Text>
        </View>
      ) : null}
    </View>
  );
}
