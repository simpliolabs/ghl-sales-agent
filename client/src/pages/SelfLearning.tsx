import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/_core/hooks/useAuth";
import { toast } from "sonner";
import { useState, useMemo } from "react";
import {
  FlaskConical, TrendingUp, Users, BarChart3, RefreshCw, Play, Pause,
  CheckCircle2, XCircle, Clock, ArrowUpRight, ArrowDownRight, Minus,
  Beaker, Target, Lightbulb, ChevronDown, ChevronUp, Trash2, AlertTriangle,
} from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

// ============================================================
// HELPER COMPONENTS
// ============================================================

function MetricCard({ label, value, subtext, icon: Icon, trend, color = "blue" }: {
  label: string; value: string | number; subtext?: string;
  icon: React.ElementType; trend?: "up" | "down" | "flat"; color?: string;
}) {
  const colorMap: Record<string, string> = {
    blue: "bg-blue-50 text-blue-600",
    green: "bg-emerald-50 text-emerald-600",
    amber: "bg-amber-50 text-amber-600",
    purple: "bg-purple-50 text-purple-600",
    rose: "bg-rose-50 text-rose-600",
  };
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-2xl font-bold">{value}</p>
            <p className="text-xs text-muted-foreground mt-1">{label}</p>
            {subtext && <p className="text-[10px] text-muted-foreground">{subtext}</p>}
          </div>
          <div className="flex flex-col items-center gap-1">
            <div className={`h-10 w-10 rounded-lg ${colorMap[color] || colorMap.blue} flex items-center justify-center`}>
              <Icon className="h-4 w-4" />
            </div>
            {trend && (
              <span className={`text-[10px] flex items-center gap-0.5 ${
                trend === "up" ? "text-emerald-600" : trend === "down" ? "text-rose-600" : "text-muted-foreground"
              }`}>
                {trend === "up" ? <ArrowUpRight className="h-3 w-3" /> : trend === "down" ? <ArrowDownRight className="h-3 w-3" /> : <Minus className="h-3 w-3" />}
              </span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; label: string }> = {
    active: { variant: "default", label: "Active" },
    paused: { variant: "secondary", label: "Paused" },
    completed: { variant: "outline", label: "Completed" },
  };
  const cfg = map[status] || { variant: "secondary" as const, label: status };
  return <Badge variant={cfg.variant}>{cfg.label}</Badge>;
}

function ProgressBar({ value, max, color = "blue" }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const colorMap: Record<string, string> = {
    blue: "bg-blue-500", green: "bg-emerald-500", amber: "bg-amber-500", purple: "bg-purple-500",
  };
  return (
    <div className="w-full bg-muted rounded-full h-2">
      <div className={`h-2 rounded-full transition-all ${colorMap[color] || colorMap.blue}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ============================================================
// MAIN PAGE
// ============================================================

export default function SelfLearning() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [activeTab, setActiveTab] = useState("overview");

  // Data queries
  const { data: summary, isLoading: summaryLoading, refetch: refetchSummary } = trpc.learning.dashboardSummary.useQuery();
  const { data: experiments, isLoading: expLoading } = trpc.learning.experiments.useQuery();
  const { data: personaMatrix, isLoading: matrixLoading } = trpc.learning.personaMatrix.useQuery();
  const { data: trends, isLoading: trendsLoading } = trpc.learning.outcomeTrends.useQuery();

  // Mutations
  const triggerSnapshot = trpc.learning.triggerSnapshot.useMutation({
    onSuccess: () => { toast.success("Daily snapshot captured"); refetchSummary(); },
    onError: () => toast.error("Snapshot failed"),
  });
  const evaluateAll = trpc.learning.evaluateAllExperiments.useMutation({
    onSuccess: (data) => toast.success(`Evaluated: ${data.evaluated} experiments, ${data.completed} completed`),
    onError: () => toast.error("Evaluation failed"),
  });
  const resetLearning = trpc.ai.resetLearningData.useMutation({
    onSuccess: (data) => {
      toast.success(`Learning data reset — ${data.archivedMessageOutcomes} outcomes cleared. Starting fresh.`);
      refetchSummary();
    },
    onError: (err) => toast.error(`Reset failed: ${err.message}`),
  });
  const backfillPersona = trpc.learning.backfillPersona.useMutation({
    onSuccess: (data) => toast.success(`Backfilled persona on ${data.updated} outcomes`),
    onError: () => toast.error("Backfill failed"),
  });
  const pauseExp = trpc.learning.pauseExperiment.useMutation({
    onSuccess: () => { toast.success("Experiment paused"); refetchSummary(); },
  });
  const resumeExp = trpc.learning.resumeExperiment.useMutation({
    onSuccess: () => { toast.success("Experiment resumed"); refetchSummary(); },
  });

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <FlaskConical className="h-6 w-6" /> Self-Learning Loop
            </h1>
            <p className="text-muted-foreground mt-1">
              A/B testing, persona-aware learning, and outcome tracking — the system improves itself over time
            </p>
          </div>
          <div className="flex gap-2">
            {isAdmin && (
              <>
                <Button size="sm" variant="outline" onClick={() => triggerSnapshot.mutate()} disabled={triggerSnapshot.isPending}>
                  <RefreshCw className={`h-3.5 w-3.5 mr-1 ${triggerSnapshot.isPending ? "animate-spin" : ""}`} />
                  Snapshot
                </Button>
                <Button size="sm" variant="outline" onClick={() => evaluateAll.mutate()} disabled={evaluateAll.isPending}>
                  <Beaker className={`h-3.5 w-3.5 mr-1 ${evaluateAll.isPending ? "animate-spin" : ""}`} />
                  Evaluate All
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" variant="outline" className="text-destructive border-destructive/40 hover:bg-destructive/10">
                      <Trash2 className="h-3.5 w-3.5 mr-1" /> Reset Learning Data
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle className="flex items-center gap-2">
                        <AlertTriangle className="h-5 w-5 text-amber-500" /> Reset Learning Data?
                      </AlertDialogTitle>
                      <AlertDialogDescription asChild>
                        <div className="space-y-2 text-sm">
                          <p>This will permanently delete all <strong>message outcomes</strong>, <strong>conversation outcomes</strong>, and <strong>auto-generated learnings</strong> accumulated to date.</p>
                          <p className="text-amber-600 font-medium">Use this when existing data is biased (e.g., after fixing the framework diversity system) so the AI starts building unbiased performance data from scratch.</p>
                          <p>The AI will continue sending messages normally — it just won’t have skewed historical data influencing its framework choices.</p>
                        </div>
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        onClick={() => resetLearning.mutate({ confirm: "RESET_CONFIRMED" })}
                        disabled={resetLearning.isPending}
                      >
                        {resetLearning.isPending ? "Resetting..." : "Yes, Reset Learning Data"}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </>
            )}
          </div>
        </div>

        {/* KPI Row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {summaryLoading ? (
            [1,2,3,4,5].map(i => <Skeleton key={i} className="h-24 w-full rounded-lg" />)
          ) : (
            <>
              <MetricCard
                label="Tracked Outcomes"
                value={summary?.patterns?.totalTracked || 0}
                icon={BarChart3}
                color="blue"
              />
              <MetricCard
                label="Reply Rate"
                value={`${summary?.patterns?.overallReplyRate || 0}%`}
                icon={TrendingUp}
                color="green"
              />
              <MetricCard
                label="Conversion Rate"
                value={`${summary?.patterns?.overallConversionRate || 0}%`}
                icon={Target}
                color="purple"
              />
              <MetricCard
                label="Active Experiments"
                value={summary?.experiments?.active || 0}
                subtext={`${summary?.experiments?.completed || 0} completed`}
                icon={FlaskConical}
                color="amber"
              />
              <MetricCard
                label="Persona Segments"
                value={summary?.personaMatrix?.length || 0}
                subtext="tracked"
                icon={Users}
                color="rose"
              />
            </>
          )}
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="experiments">A/B Experiments</TabsTrigger>
            <TabsTrigger value="personas">Persona Matrix</TabsTrigger>
            <TabsTrigger value="trends">Trends</TabsTrigger>
          </TabsList>

          {/* ============ OVERVIEW TAB ============ */}
          <TabsContent value="overview" className="space-y-6 mt-4">
            <OverviewTab summary={summary} isLoading={summaryLoading} />
          </TabsContent>

          {/* ============ EXPERIMENTS TAB ============ */}
          <TabsContent value="experiments" className="space-y-6 mt-4">
            <ExperimentsTab
              experiments={experiments}
              isLoading={expLoading}
              isAdmin={isAdmin}
              onPause={(id) => pauseExp.mutate({ experimentId: id })}
              onResume={(id) => resumeExp.mutate({ experimentId: id })}
            />
          </TabsContent>

          {/* ============ PERSONA MATRIX TAB ============ */}
          <TabsContent value="personas" className="space-y-6 mt-4">
            <PersonaMatrixTab
              matrix={personaMatrix}
              isLoading={matrixLoading}
              isAdmin={isAdmin}
              onBackfill={() => backfillPersona.mutate()}
              backfillPending={backfillPersona.isPending}
            />
          </TabsContent>

          {/* ============ TRENDS TAB ============ */}
          <TabsContent value="trends" className="space-y-6 mt-4">
            <TrendsTab trends={trends} isLoading={trendsLoading} />
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}

// ============================================================
// OVERVIEW TAB
// ============================================================

function OverviewTab({ summary, isLoading }: { summary: any; isLoading: boolean }) {
  if (isLoading) return <div className="space-y-4">{[1,2,3].map(i => <Skeleton key={i} className="h-48 w-full rounded-lg" />)}</div>;
  if (!summary) return <p className="text-muted-foreground">No data available yet.</p>;

  const { patterns, experiments, personaMatrix, trends } = summary;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Framework Performance */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart3 className="h-4 w-4" /> Framework Performance
          </CardTitle>
          <CardDescription>Win rates by messaging framework</CardDescription>
        </CardHeader>
        <CardContent>
          {patterns?.frameworkStats?.length > 0 ? (
            <div className="space-y-3">
              {patterns.frameworkStats
                .sort((a: any, b: any) => b.replyRate - a.replyRate)
                .slice(0, 8)
                .map((fw: any) => (
                  <div key={fw.framework} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium truncate max-w-[200px]">{fw.framework}</span>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span>{fw.replyRate}% reply</span>
                        <span>{fw.positiveRate}% positive</span>
                        <span className="text-foreground font-medium">{fw.totalSent} sent</span>
                      </div>
                    </div>
                    <ProgressBar value={fw.replyRate} max={100} color={fw.replyRate > 20 ? "green" : fw.replyRate > 10 ? "blue" : "amber"} />
                  </div>
                ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Not enough data yet. Send more messages to see framework performance.</p>
          )}
        </CardContent>
      </Card>

      {/* Top Performing Combos */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Target className="h-4 w-4" /> Top Performing Combos
          </CardTitle>
          <CardDescription>Best framework × segment combinations</CardDescription>
        </CardHeader>
        <CardContent>
          {patterns?.topPerformers?.length > 0 ? (
            <div className="space-y-2">
              {patterns.topPerformers.slice(0, 6).map((tp: any, i: number) => (
                <div key={i} className="flex items-center justify-between p-2 rounded-md bg-muted/50">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground w-5">#{i + 1}</span>
                    <div>
                      <p className="text-sm font-medium">{tp.framework}</p>
                      <p className="text-xs text-muted-foreground">{tp.segment}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold text-emerald-600">{tp.replyRate}%</p>
                    <p className="text-[10px] text-muted-foreground">n={tp.sampleSize}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Need more segment-tagged outcomes to find top combos.</p>
          )}
        </CardContent>
      </Card>

      {/* Active Experiments Summary */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FlaskConical className="h-4 w-4" /> Experiment Status
          </CardTitle>
          <CardDescription>{experiments?.total || 0} total experiments</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-4 mb-4">
            <div className="flex items-center gap-2">
              <div className="h-3 w-3 rounded-full bg-blue-500" />
              <span className="text-sm">{experiments?.active || 0} active</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-3 w-3 rounded-full bg-emerald-500" />
              <span className="text-sm">{experiments?.completed || 0} completed</span>
            </div>
          </div>
          {experiments?.recent?.length > 0 ? (
            <div className="space-y-2">
              {experiments.recent.map((exp: any) => (
                <div key={exp.id} className="flex items-center justify-between p-2 rounded-md bg-muted/50">
                  <div>
                    <p className="text-sm font-medium">{exp.name}</p>
                    <p className="text-xs text-muted-foreground">
                      A: {exp.variantASamples || 0} / B: {exp.variantBSamples || 0} samples
                    </p>
                  </div>
                  <StatusBadge status={exp.status} />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No experiments created yet.</p>
          )}
        </CardContent>
      </Card>

      {/* Persona Highlights */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="h-4 w-4" /> Persona Highlights
          </CardTitle>
          <CardDescription>Top performing segments</CardDescription>
        </CardHeader>
        <CardContent>
          {personaMatrix?.length > 0 ? (
            <div className="space-y-2">
              {personaMatrix
                .sort((a: any, b: any) => b.replyRate - a.replyRate)
                .slice(0, 6)
                .map((p: any) => (
                  <div key={p.persona} className="flex items-center justify-between p-2 rounded-md bg-muted/50">
                    <div className="min-w-0">
                      <p className="text-sm font-medium capitalize">{p.persona.replace(/_/g, " ")}</p>
                      <p className="text-xs text-muted-foreground">{p.totalMessages} messages</p>
                    </div>
                    <div className="text-right shrink-0 ml-3">
                      <p className="text-sm font-bold">{p.replyRate}% reply</p>
                      {p.bestFramework && (
                        <p className="text-[10px] text-muted-foreground">Best: {p.bestFramework}</p>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Persona data will appear after more messages are sent and attributed.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
// EXPERIMENTS TAB
// ============================================================

function ExperimentsTab({ experiments, isLoading, isAdmin, onPause, onResume }: {
  experiments: any; isLoading: boolean; isAdmin: boolean;
  onPause: (id: string) => void; onResume: (id: string) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (isLoading) return <div className="space-y-4">{[1,2,3].map(i => <Skeleton key={i} className="h-32 w-full rounded-lg" />)}</div>;

  if (!experiments || experiments.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="text-center py-8">
            <FlaskConical className="h-12 w-12 mx-auto text-muted-foreground/30 mb-3" />
            <h3 className="text-lg font-medium">No Experiments Yet</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
              A/B experiments are created automatically by the Brain Council when it detects competing strategies,
              or you can create them manually via the API. The system will split traffic between variants and
              determine a statistically significant winner.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {experiments.map((exp: any) => {
        const isExpanded = expandedId === exp.experimentId;
        const totalA = exp.variantASamples || 0;
        const totalB = exp.variantBSamples || 0;
        const successA = exp.variantASuccesses || 0;
        const successB = exp.variantBSuccesses || 0;
        const rateA = totalA > 0 ? Math.round((successA / totalA) * 100) : 0;
        const rateB = totalB > 0 ? Math.round((successB / totalB) * 100) : 0;
        const totalSamples = totalA + totalB;
        const targetSamples = exp.sampleSizeTarget || 50;
        const progress = Math.min(100, Math.round((totalSamples / (targetSamples * 2)) * 100));

        return (
          <Card key={exp.experimentId}>
            <CardContent className="pt-6">
              <div
                className="flex items-start justify-between cursor-pointer"
                onClick={() => setExpandedId(isExpanded ? null : exp.experimentId)}
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-medium">{exp.name}</h3>
                    <StatusBadge status={exp.status} />
                    {exp.winnerVariant && (
                      <Badge variant="outline" className="text-emerald-600 border-emerald-200 bg-emerald-50">
                        Winner: {exp.winnerVariant}
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">{exp.hypothesis}</p>
                  <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                    <span>Metric: {exp.primaryMetric}</span>
                    <span>Target: {targetSamples} per variant</span>
                    {exp.targetSegment && <span>Segment: {exp.targetSegment}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {isAdmin && exp.status === "active" && (
                    <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onPause(exp.experimentId); }}>
                      <Pause className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  {isAdmin && exp.status === "paused" && (
                    <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onResume(exp.experimentId); }}>
                      <Play className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </div>
              </div>

              {/* Progress bar */}
              <div className="mt-3">
                <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                  <span>Progress: {totalSamples} / {targetSamples * 2} samples</span>
                  <span>{progress}%</span>
                </div>
                <ProgressBar value={progress} max={100} color={exp.status === "completed" ? "green" : "blue"} />
              </div>

              {/* Expanded details */}
              {isExpanded && (
                <div className="mt-4 pt-4 border-t space-y-4">
                  {/* Variant comparison */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className={`p-4 rounded-lg border ${exp.winnerVariant === "A" ? "border-emerald-300 bg-emerald-50/50" : "bg-muted/30"}`}>
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="font-medium text-sm">Variant A</h4>
                        {exp.winnerVariant === "A" && <CheckCircle2 className="h-4 w-4 text-emerald-600" />}
                      </div>
                      <p className="text-xs text-muted-foreground mb-3">{exp.variantADescription}</p>
                      <div className="grid grid-cols-2 gap-2 text-center">
                        <div>
                          <p className="text-lg font-bold">{rateA}%</p>
                          <p className="text-[10px] text-muted-foreground">Success Rate</p>
                        </div>
                        <div>
                          <p className="text-lg font-bold">{totalA}</p>
                          <p className="text-[10px] text-muted-foreground">Samples</p>
                        </div>
                      </div>
                    </div>
                    <div className={`p-4 rounded-lg border ${exp.winnerVariant === "B" ? "border-emerald-300 bg-emerald-50/50" : "bg-muted/30"}`}>
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="font-medium text-sm">Variant B</h4>
                        {exp.winnerVariant === "B" && <CheckCircle2 className="h-4 w-4 text-emerald-600" />}
                      </div>
                      <p className="text-xs text-muted-foreground mb-3">{exp.variantBDescription}</p>
                      <div className="grid grid-cols-2 gap-2 text-center">
                        <div>
                          <p className="text-lg font-bold">{rateB}%</p>
                          <p className="text-[10px] text-muted-foreground">Success Rate</p>
                        </div>
                        <div>
                          <p className="text-lg font-bold">{totalB}</p>
                          <p className="text-[10px] text-muted-foreground">Samples</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Config details */}
                  <div className="grid grid-cols-2 gap-4 text-xs">
                    <div>
                      <p className="font-medium mb-1">Variant A Config:</p>
                      <pre className="bg-muted/50 p-2 rounded text-[10px] overflow-x-auto">
                        {JSON.stringify(exp.variantAConfig, null, 2)}
                      </pre>
                    </div>
                    <div>
                      <p className="font-medium mb-1">Variant B Config:</p>
                      <pre className="bg-muted/50 p-2 rounded text-[10px] overflow-x-auto">
                        {JSON.stringify(exp.variantBConfig, null, 2)}
                      </pre>
                    </div>
                  </div>

                  {exp.pValue && (
                    <div className="text-xs text-muted-foreground">
                      <span className="font-medium">p-value:</span> {exp.pValue} |{" "}
                      <span className="font-medium">Confidence threshold:</span> {exp.confidenceThreshold}% |{" "}
                      <span className="font-medium">Auto-adopt:</span> {exp.autoAdopt ? "Yes" : "No"}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// ============================================================
// PERSONA MATRIX TAB
// ============================================================

function PersonaMatrixTab({ matrix, isLoading, isAdmin, onBackfill, backfillPending }: {
  matrix: any; isLoading: boolean; isAdmin: boolean;
  onBackfill: () => void; backfillPending: boolean;
}) {
  const [expandedPersona, setExpandedPersona] = useState<string | null>(null);

  if (isLoading) return <div className="space-y-4">{[1,2,3].map(i => <Skeleton key={i} className="h-32 w-full rounded-lg" />)}</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Persona Performance Matrix</h2>
          <p className="text-sm text-muted-foreground">
            How each customer segment responds to different messaging strategies
          </p>
        </div>
        {isAdmin && (
          <Button size="sm" variant="outline" onClick={onBackfill} disabled={backfillPending}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1 ${backfillPending ? "animate-spin" : ""}`} />
            Backfill Persona Tags
          </Button>
        )}
      </div>

      {!matrix || matrix.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <div className="text-center py-8">
              <Users className="h-12 w-12 mx-auto text-muted-foreground/30 mb-3" />
              <h3 className="text-lg font-medium">No Persona Data Yet</h3>
              <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
                Persona data is collected as the AI sends messages and outcomes are tracked.
                Use "Backfill Persona Tags" to retroactively tag existing outcomes.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {matrix
            .sort((a: any, b: any) => b.totalMessages - a.totalMessages)
            .map((p: any) => (
              <Card
                key={p.persona}
                className={`cursor-pointer transition-shadow hover:shadow-md ${expandedPersona === p.persona ? "ring-2 ring-primary/20" : ""}`}
                onClick={() => setExpandedPersona(expandedPersona === p.persona ? null : p.persona)}
              >
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-medium capitalize text-base">{p.persona}</h3>
                    <Badge variant="secondary">{p.totalMessages} msgs</Badge>
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-center mb-3">
                    <div>
                      <p className="text-lg font-bold text-blue-600">{p.replyRate}%</p>
                      <p className="text-[10px] text-muted-foreground">Reply Rate</p>
                    </div>
                    <div>
                      <p className="text-lg font-bold text-emerald-600">{p.positiveRate || 0}%</p>
                      <p className="text-[10px] text-muted-foreground">Positive</p>
                    </div>
                    <div>
                      <p className="text-lg font-bold text-purple-600">{p.conversionRate || 0}%</p>
                      <p className="text-[10px] text-muted-foreground">Conversion</p>
                    </div>
                  </div>

                  {p.bestFramework && (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground bg-muted/50 rounded px-2 py-1">
                      <Lightbulb className="h-3 w-3 text-amber-500" />
                      Best: <span className="font-medium text-foreground">{p.bestFramework}</span>
                      {p.bestFrameworkRate && <span>({p.bestFrameworkRate}%)</span>}
                    </div>
                  )}

                  {expandedPersona === p.persona && p.frameworkBreakdown && (
                    <div className="mt-3 pt-3 border-t space-y-2">
                      <p className="text-xs font-medium">Framework Breakdown:</p>
                      {p.frameworkBreakdown.map((fb: any) => (
                        <div key={fb.framework} className="flex items-center justify-between text-xs">
                          <span className="truncate max-w-[140px]">{fb.framework}</span>
                          <div className="flex items-center gap-2">
                            <span>{fb.replyRate}% reply</span>
                            <span className="text-muted-foreground">({fb.count})</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// TRENDS TAB
// ============================================================

function TrendsTab({ trends, isLoading }: { trends: any; isLoading: boolean }) {
  if (isLoading) return <div className="space-y-4">{[1,2,3].map(i => <Skeleton key={i} className="h-48 w-full rounded-lg" />)}</div>;

  if (!trends || !trends.snapshots || trends.snapshots.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="text-center py-8">
            <TrendingUp className="h-12 w-12 mx-auto text-muted-foreground/30 mb-3" />
            <h3 className="text-lg font-medium">No Trend Data Yet</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
              Daily snapshots are captured automatically. Trends will appear after a few days of data collection.
              You can also manually trigger a snapshot from the header.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const { snapshots, trends: trendData } = trends;

  return (
    <div className="space-y-6">
      {/* Trend Summary Cards */}
      {trendData && trendData.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {trendData.map((t: any) => (
            <Card key={t.metric}>
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium capitalize">{t.metric.replace(/_/g, " ")}</p>
                    <p className="text-2xl font-bold mt-1">
                      {typeof t.current === "number" ? (t.metric.includes("rate") ? `${t.current}%` : t.current) : t.current}
                    </p>
                  </div>
                  <div className={`text-sm font-medium flex items-center gap-1 ${
                    t.direction === "up" ? "text-emerald-600" : t.direction === "down" ? "text-rose-600" : "text-muted-foreground"
                  }`}>
                    {t.direction === "up" ? <ArrowUpRight className="h-4 w-4" /> :
                     t.direction === "down" ? <ArrowDownRight className="h-4 w-4" /> :
                     <Minus className="h-4 w-4" />}
                    {t.changePercent !== undefined && `${t.changePercent > 0 ? "+" : ""}${t.changePercent}%`}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Previous: {typeof t.previous === "number" ? (t.metric.includes("rate") ? `${t.previous}%` : t.previous) : t.previous}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Daily Snapshots Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Daily Snapshots</CardTitle>
          <CardDescription>Day-by-day performance metrics</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 px-3 font-medium">Date</th>
                  <th className="text-right py-2 px-3 font-medium">Sent</th>
                  <th className="text-right py-2 px-3 font-medium">Replies</th>
                  <th className="text-right py-2 px-3 font-medium">Reply %</th>
                  <th className="text-right py-2 px-3 font-medium">Positive</th>
                  <th className="text-right py-2 px-3 font-medium">Conversions</th>
                  <th className="text-right py-2 px-3 font-medium">DNC</th>
                  <th className="text-left py-2 px-3 font-medium">Top Framework</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s: any) => {
                  const replyRate = s.messagesSent > 0 ? Math.round((s.replies / s.messagesSent) * 100) : 0;
                  return (
                    <tr key={s.snapshotDate} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="py-2 px-3 font-medium">{s.snapshotDate}</td>
                      <td className="py-2 px-3 text-right">{s.messagesSent}</td>
                      <td className="py-2 px-3 text-right">{s.replies}</td>
                      <td className="py-2 px-3 text-right">
                        <span className={replyRate > 15 ? "text-emerald-600 font-medium" : replyRate > 5 ? "text-blue-600" : "text-muted-foreground"}>
                          {replyRate}%
                        </span>
                      </td>
                      <td className="py-2 px-3 text-right">{s.positiveReplies || 0}</td>
                      <td className="py-2 px-3 text-right">{s.conversions || 0}</td>
                      <td className="py-2 px-3 text-right">
                        {(s.dncCount || 0) > 0 ? (
                          <span className="text-rose-600">{s.dncCount}</span>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-xs truncate max-w-[120px]">{s.topFramework || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
