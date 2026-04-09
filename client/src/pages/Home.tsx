import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Flame, Users, Brain, TrendingUp, MessageSquare, UserCheck, ShieldCheck, Activity, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

export default function Home() {
  const { data: perf, isLoading: perfLoading } = trpc.ai.performance.useQuery();
  const { data: pipelineStats, isLoading: pipeLoading } = trpc.pipeline.stats.useQuery();
  const { data: hotLeads, isLoading: hotLoading } = trpc.leads.hot.useQuery();
  const { data: agentWork, isLoading: agentLoading } = trpc.agents.workload.useQuery();
  const { data: supervisorStatus, isLoading: supLoading } = trpc.ai.supervisorStatus.useQuery(undefined, { refetchInterval: 60000 });
  const triggerSupervisor = trpc.ai.triggerSupervisor.useMutation({
    onSuccess: () => { utils.ai.supervisorStatus.invalidate(); },
  });
  const utils = trpc.useUtils();

  const totalPipelineValue = pipelineStats?.reduce((sum: number, s: { totalValue?: string }) => sum + parseFloat(s.totalValue || "0"), 0) || 0;
  const isLoading = perfLoading || pipeLoading || hotLoading || agentLoading;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground mt-1">Adorb Outreach command center</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard title="Hot Leads" value={isLoading ? undefined : String(hotLeads?.length || 0)} subtitle="Score 80+" icon={<Flame className="h-4 w-4 text-orange-500" />} loading={isLoading} />
          <MetricCard title="Total Leads" value={isLoading ? undefined : String(perf?.totalLeads || 0)} subtitle="In system" icon={<Users className="h-4 w-4 text-blue-500" />} loading={isLoading} />
          <MetricCard title="AI Messages" value={isLoading ? undefined : String(perf?.aiMessages || 0)} subtitle={`of ${perf?.totalMessages || 0} total`} icon={<MessageSquare className="h-4 w-4 text-emerald-500" />} loading={isLoading} />
          <MetricCard title="Pipeline Value" value={isLoading ? undefined : `$${totalPipelineValue.toLocaleString()}`} subtitle="Total opportunity" icon={<TrendingUp className="h-4 w-4 text-violet-500" />} loading={isLoading} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <CardHeader><CardTitle className="text-base">Pipeline Breakdown</CardTitle></CardHeader>
            <CardContent>
              {pipeLoading ? (
                <div className="space-y-3">{[1,2,3].map(i => <Skeleton key={i} className="h-8 w-full" />)}</div>
              ) : pipelineStats && pipelineStats.length > 0 ? (
                <div className="space-y-3">
                  {pipelineStats.map((stage: { stage: string; count: number; totalValue?: string }) => (
                    <div key={stage.stage || "unknown"} className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-2 h-2 rounded-full bg-primary" />
                        <span className="text-sm font-medium">{stage.stage || "Unknown"}</span>
                      </div>
                      <div className="flex items-center gap-4">
                        <span className="text-sm text-muted-foreground">{stage.count} leads</span>
                        <span className="text-sm font-medium">${parseFloat(stage.totalValue || "0").toLocaleString()}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No pipeline data yet. Sync contacts from GHL to get started.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Agent Workload</CardTitle></CardHeader>
            <CardContent>
              {agentLoading ? (
                <div className="space-y-3">{[1,2].map(i => <Skeleton key={i} className="h-8 w-full" />)}</div>
              ) : agentWork && agentWork.length > 0 ? (
                <div className="space-y-3">
                  {agentWork.map((a: { agent: string | null; count: number }) => (
                    <div key={a.agent || "unassigned"} className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <UserCheck className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm font-medium">{a.agent || "Unassigned"}</span>
                      </div>
                      <span className="text-sm text-muted-foreground">{a.count} leads</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No agent assignments yet.</p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ═══ SUPERVISOR HEALTH ═══ */}
        <Card className={supervisorStatus?.healthy === false ? 'border-red-500/50' : supervisorStatus?.healthy ? 'border-emerald-500/30' : ''}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <ShieldCheck className="h-4 w-4" />
                Supervisor Health
                {supervisorStatus && (
                  <Badge variant={supervisorStatus.healthy ? 'default' : 'destructive'} className="ml-2 text-xs">
                    {supervisorStatus.healthy ? 'Healthy' : 'Issues Detected'}
                  </Badge>
                )}
              </CardTitle>
              <Button size="sm" variant="outline" onClick={() => triggerSupervisor.mutate()} disabled={triggerSupervisor.isPending}>
                {triggerSupervisor.isPending ? 'Running...' : 'Run Now'}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {supLoading ? (
              <div className="space-y-3">{[1,2].map(i => <Skeleton key={i} className="h-8 w-full" />)}</div>
            ) : supervisorStatus ? (
              <div className="space-y-4">
                {supervisorStatus.lastCycle && (
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                    <div className="text-center"><p className="text-xl font-bold">{supervisorStatus.lastCycle.leadsChecked}</p><p className="text-xs text-muted-foreground">Leads Checked</p></div>
                    <div className="text-center"><p className="text-xl font-bold">{supervisorStatus.lastCycle.violationsFound}</p><p className="text-xs text-muted-foreground">Violations</p></div>
                    <div className="text-center"><p className="text-xl font-bold text-emerald-500">{supervisorStatus.lastCycle.correctionsMade}</p><p className="text-xs text-muted-foreground">Corrected</p></div>
                    <div className="text-center"><p className="text-xl font-bold text-red-500">{supervisorStatus.lastCycle.correctionsFailed}</p><p className="text-xs text-muted-foreground">Failed</p></div>
                    <div className="text-center"><p className="text-xl font-bold">{supervisorStatus.lastCycle.durationMs}ms</p><p className="text-xs text-muted-foreground">Duration</p></div>
                  </div>
                )}
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-2">Timer Health</p>
                  <div className="flex flex-wrap gap-2">
                    {supervisorStatus.timerHealth.timers.map((t: any) => (
                      <div key={t.name} className="flex items-center gap-1.5 text-xs">
                        <div className={`w-2 h-2 rounded-full ${t.status === 'green' ? 'bg-emerald-500' : t.status === 'yellow' ? 'bg-yellow-500' : 'bg-red-500'}`} />
                        <span className="text-muted-foreground">{t.name.replace('timer_', '').replace('_last_run', '')}</span>
                      </div>
                    ))}
                  </div>
                </div>
                {supervisorStatus.lastCycle?.violations && supervisorStatus.lastCycle.violations.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">Recent Corrections</p>
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {supervisorStatus.lastCycle.violations.slice(0, 10).map((v: any, i: number) => (
                        <div key={i} className="flex items-start gap-2 text-xs">
                          {v.success ? <Activity className="h-3 w-3 text-emerald-500 mt-0.5 shrink-0" /> : <AlertTriangle className="h-3 w-3 text-red-500 mt-0.5 shrink-0" />}
                          <span className="text-muted-foreground">Lead #{v.leadId}: <span className="font-medium">{v.invariant}</span> — {v.correction}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Supervisor not yet initialized. It will run automatically in 3 minutes.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><Brain className="h-4 w-4" />AI Brain Status</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="text-center"><p className="text-2xl font-bold">{perf?.avgScore || 0}</p><p className="text-xs text-muted-foreground">Avg Lead Score</p></div>
              <div className="text-center"><p className="text-2xl font-bold">{perf?.hotLeads || 0}</p><p className="text-xs text-muted-foreground">Hot Leads</p></div>
              <div className="text-center"><p className="text-2xl font-bold">{perf?.aiMessages || 0}</p><p className="text-xs text-muted-foreground">AI Messages</p></div>
              <div className="text-center"><p className="text-2xl font-bold">{perf?.totalMessages || 0}</p><p className="text-xs text-muted-foreground">Total Messages</p></div>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}

function MetricCard({ title, value, subtitle, icon, loading }: { title: string; value?: string; subtitle: string; icon: React.ReactNode; loading: boolean }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            {loading ? <Skeleton className="h-7 w-16 mb-1" /> : <p className="text-2xl font-bold">{value}</p>}
            <p className="text-xs text-muted-foreground mt-1">{title}</p>
          </div>
          <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">{icon}</div>
        </div>
        <p className="text-xs text-muted-foreground mt-2">{subtitle}</p>
      </CardContent>
    </Card>
  );
}
