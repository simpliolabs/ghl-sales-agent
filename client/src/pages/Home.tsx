import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Flame, Users, Brain, TrendingUp, MessageSquare, UserCheck, ShieldCheck, Activity, AlertTriangle, Clock, CalendarClock, BarChart3, Zap, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export default function Home() {
  const { data: perf, isLoading: perfLoading } = trpc.ai.performance.useQuery();
  const { data: pipelineStats, isLoading: pipeLoading } = trpc.pipeline.stats.useQuery();
  const { data: hotLeads, isLoading: hotLoading } = trpc.leads.hot.useQuery();
  const { data: agentWork, isLoading: agentLoading } = trpc.agents.workload.useQuery();
  const { data: scheduleDist, isLoading: schedLoading } = trpc.leads.scheduleDistribution.useQuery(undefined, { refetchInterval: 120000 });
  const { data: healthData, isLoading: healthLoading } = trpc.system.healthMonitor.useQuery(undefined, { refetchInterval: 60000 });
  const { data: supervisorStatus, isLoading: supLoading } = trpc.ai.supervisorStatus.useQuery(undefined, { refetchInterval: 60000 });
  const { data: learningStatus, isLoading: learningLoading } = trpc.learning.aiLearningStatus.useQuery(undefined, { refetchInterval: 120000 });
  const triggerSupervisor = trpc.ai.triggerSupervisor.useMutation({
    onSuccess: () => { utils.ai.supervisorStatus.invalidate(); },
  });
  const utils = trpc.useUtils();

  const totalPipelineValue = pipelineStats?.reduce((sum: number, s: { totalValue?: string }) => sum + parseFloat(s.totalValue || "0"), 0) || 0;
  const isLoading = perfLoading || pipeLoading || hotLoading || agentLoading;

  // Schedule distribution total for percentage bars
  const schedTotal = scheduleDist
    ? scheduleDist.overdue + scheduleDist.today + scheduleDist.week1 + scheduleDist.week2 + scheduleDist.month + scheduleDist.beyond + scheduleDist.noSchedule + scheduleDist.humanTakeover
    : 0;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground mt-1">Adorb Outreach command center</p>
        </div>

        {/* ═══ TOP KPI CARDS ═══ */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard title="Hot Leads" value={isLoading ? undefined : String(hotLeads?.length || 0)} subtitle="Score 80+" icon={<Flame className="h-4 w-4 text-orange-500" />} loading={isLoading} />
          <MetricCard title="Total Leads" value={isLoading ? undefined : String(perf?.totalLeads || 0)} subtitle="In system" icon={<Users className="h-4 w-4 text-blue-500" />} loading={isLoading} />
          <MetricCard title="AI Messages" value={isLoading ? undefined : String(perf?.aiMessages || 0)} subtitle={`of ${perf?.totalMessages || 0} total`} icon={<MessageSquare className="h-4 w-4 text-emerald-500" />} loading={isLoading} />
          <MetricCard title="Pipeline Value" value={isLoading ? undefined : `$${totalPipelineValue.toLocaleString()}`} subtitle="Total opportunity" icon={<TrendingUp className="h-4 w-4 text-violet-500" />} loading={isLoading} />
        </div>

        {/* ═══ SYSTEM HEALTH INDICATORS ═══ */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Zap className="h-4 w-4" />
                System Health
                {healthData && (
                  <Badge
                    variant={healthData.overall === 'green' ? 'default' : healthData.overall === 'yellow' ? 'secondary' : 'destructive'}
                    className="ml-2 text-xs"
                  >
                    {healthData.overall === 'green' ? 'All Systems Go' : healthData.overall === 'yellow' ? 'Warnings' : 'Issues Detected'}
                  </Badge>
                )}
              </CardTitle>
              <span className="text-xs text-muted-foreground">
                {healthData?.lastUpdated ? `Updated ${new Date(healthData.lastUpdated).toLocaleTimeString()}` : ''}
              </span>
            </div>
          </CardHeader>
          <CardContent>
            {healthLoading ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                {[1,2,3,4,5,6].map(i => <Skeleton key={i} className="h-16 w-full" />)}
              </div>
            ) : healthData?.indicators && healthData.indicators.length > 0 ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                {healthData.indicators.map((ind: { name: string; status: string; value: string; detail: string }) => (
                  <Tooltip key={ind.name}>
                    <TooltipTrigger asChild>
                      <div className={`rounded-lg border p-3 text-center cursor-help transition-colors ${
                        ind.status === 'green' ? 'border-emerald-200 bg-emerald-50/50' :
                        ind.status === 'yellow' ? 'border-yellow-200 bg-yellow-50/50' :
                        'border-red-200 bg-red-50/50'
                      }`}>
                        <div className={`w-2 h-2 rounded-full mx-auto mb-1.5 ${
                          ind.status === 'green' ? 'bg-emerald-500' :
                          ind.status === 'yellow' ? 'bg-yellow-500' :
                          'bg-red-500'
                        }`} />
                        <p className="text-xs font-medium truncate">{ind.name}</p>
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">{ind.value}</p>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      <p className="font-medium">{ind.name}</p>
                      <p className="text-xs">{ind.detail}</p>
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Health data not available yet.</p>
            )}
          </CardContent>
        </Card>

        {/* ═══ SCHEDULE DISTRIBUTION + PIPELINE ═══ */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Schedule Distribution */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <CalendarClock className="h-4 w-4" />
                Schedule Distribution
              </CardTitle>
            </CardHeader>
            <CardContent>
              {schedLoading ? (
                <div className="space-y-3">{[1,2,3,4].map(i => <Skeleton key={i} className="h-8 w-full" />)}</div>
              ) : scheduleDist ? (
                <div className="space-y-2.5">
                  <ScheduleBar label="Overdue" count={scheduleDist.overdue} total={schedTotal} color="bg-red-500" textColor="text-red-700" />
                  <ScheduleBar label="Today" count={scheduleDist.today} total={schedTotal} color="bg-orange-500" textColor="text-orange-700" />
                  <ScheduleBar label="1-7 Days" count={scheduleDist.week1} total={schedTotal} color="bg-emerald-500" textColor="text-emerald-700" />
                  <ScheduleBar label="8-14 Days" count={scheduleDist.week2} total={schedTotal} color="bg-blue-500" textColor="text-blue-700" />
                  <ScheduleBar label="15-30 Days" count={scheduleDist.month} total={schedTotal} color="bg-violet-500" textColor="text-violet-700" />
                  <ScheduleBar label="30+ Days" count={scheduleDist.beyond} total={schedTotal} color="bg-gray-400" textColor="text-gray-600" />
                  <div className="border-t pt-2 mt-2 flex justify-between text-xs text-muted-foreground">
                    <span>No Schedule: <span className="font-medium text-foreground">{scheduleDist.noSchedule}</span></span>
                    <span>Human Takeover: <span className="font-medium text-foreground">{scheduleDist.humanTakeover}</span></span>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No schedule data available.</p>
              )}
            </CardContent>
          </Card>

          {/* Pipeline Breakdown */}
          <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><BarChart3 className="h-4 w-4" />Pipeline Breakdown</CardTitle></CardHeader>
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
                <p className="text-sm text-muted-foreground">No pipeline data yet.</p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ═══ SUPERVISOR HEALTH + AGENT WORKLOAD ═══ */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Supervisor Health */}
          <Card className={supervisorStatus?.healthy === false ? 'border-red-500/50' : supervisorStatus?.healthy ? 'border-emerald-500/30' : ''}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4" />
                  Supervisor
                  {supervisorStatus && (
                    <Badge variant={supervisorStatus.healthy ? 'default' : 'destructive'} className="ml-1 text-xs">
                      {supervisorStatus.healthy ? 'Healthy' : 'Issues'}
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
                    <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                      <div className="text-center"><p className="text-lg font-bold">{supervisorStatus.lastCycle.leadsChecked}</p><p className="text-[10px] text-muted-foreground">Checked</p></div>
                      <div className="text-center"><p className="text-lg font-bold">{supervisorStatus.lastCycle.violationsFound}</p><p className="text-[10px] text-muted-foreground">Violations</p></div>
                      <div className="text-center"><p className="text-lg font-bold text-emerald-600">{supervisorStatus.lastCycle.correctionsMade}</p><p className="text-[10px] text-muted-foreground">Fixed</p></div>
                      <div className="text-center hidden sm:block"><p className="text-lg font-bold text-red-500">{supervisorStatus.lastCycle.correctionsFailed}</p><p className="text-[10px] text-muted-foreground">Failed</p></div>
                      <div className="text-center hidden sm:block"><p className="text-lg font-bold">{supervisorStatus.lastCycle.durationMs}ms</p><p className="text-[10px] text-muted-foreground">Duration</p></div>
                    </div>
                  )}
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">Timer Health</p>
                    <div className="flex flex-wrap gap-2">
                      {supervisorStatus.timerHealth.timers.map((t: any) => (
                        <Tooltip key={t.name}>
                          <TooltipTrigger asChild>
                            <div className="flex items-center gap-1.5 text-xs cursor-help">
                              <div className={`w-2 h-2 rounded-full ${t.status === 'green' ? 'bg-emerald-500' : t.status === 'yellow' ? 'bg-yellow-500' : 'bg-red-500'}`} />
                              <span className="text-muted-foreground">{t.name.replace('timer_', '').replace('_last_run', '')}</span>
                            </div>
                          </TooltipTrigger>
                          <TooltipContent><p>{t.name}: {t.status}</p></TooltipContent>
                        </Tooltip>
                      ))}
                    </div>
                  </div>
                  {supervisorStatus.lastCycle?.violations && supervisorStatus.lastCycle.violations.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1.5">Recent Corrections</p>
                      <div className="space-y-1 max-h-32 overflow-y-auto">
                        {supervisorStatus.lastCycle.violations.slice(0, 8).map((v: any, i: number) => (
                          <div key={i} className="flex items-start gap-2 text-xs">
                            {v.success ? <CheckCircle2 className="h-3 w-3 text-emerald-500 mt-0.5 shrink-0" /> : <XCircle className="h-3 w-3 text-red-500 mt-0.5 shrink-0" />}
                            <span className="text-muted-foreground truncate">#{v.leadId}: <span className="font-medium">{v.invariant}</span></span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Supervisor initializing... runs every 5 minutes.</p>
              )}
            </CardContent>
          </Card>

          {/* Agent Workload */}
          <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><UserCheck className="h-4 w-4" />Agent Workload</CardTitle></CardHeader>
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

        {/* ═══ AI LEARNING STATUS ═══ */}
        <Card className="border-violet-500/30">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Brain className="h-4 w-4 text-violet-500" />
                AI Learning Engine
                <Badge variant="secondary" className="ml-1 text-xs">Self-Improving</Badge>
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            {learningLoading ? (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                {[1,2,3,4].map(i => <Skeleton key={i} className="h-16 w-full" />)}
              </div>
            ) : learningStatus ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div className="text-center">
                    <p className="text-2xl font-bold text-violet-600">{learningStatus.hallOfFameTotal}</p>
                    <p className="text-xs text-muted-foreground">Winning Examples</p>
                  </div>
                  <div className="text-center">
                    <p className="text-2xl font-bold text-emerald-600">+{learningStatus.hallOfFameThisWeek}</p>
                    <p className="text-xs text-muted-foreground">New This Week</p>
                  </div>
                  <div className="text-center">
                    <p className="text-2xl font-bold text-blue-600">{learningStatus.approvedSkills}</p>
                    <p className="text-xs text-muted-foreground">Active Skills</p>
                  </div>
                  <div className="text-center">
                    <p className="text-2xl font-bold text-orange-600">{learningStatus.activeStrategyAdjustments}</p>
                    <p className="text-xs text-muted-foreground">Strategy Tweaks</p>
                  </div>
                </div>
                <div className="rounded-lg bg-muted/50 p-3">
                  <div className="flex items-center gap-2">
                    <Activity className="h-3.5 w-3.5 text-violet-500" />
                    <span className="text-xs font-medium">Engine: Dynamic Few-Shot Retrieval</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{learningStatus.engineDescription}</p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Learning engine initializing...</p>
            )}
          </CardContent>
        </Card>

        {/* ═══ AI BRAIN STATUS ═══ */}
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

function ScheduleBar({ label, count, total, color, textColor }: { label: string; count: number; total: number; color: string; textColor: string }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className={`text-xs font-medium w-20 text-right ${textColor}`}>{label}</span>
      <div className="flex-1 h-5 bg-muted rounded-full overflow-hidden relative">
        <div
          className={`h-full ${color} rounded-full transition-all duration-500`}
          style={{ width: `${Math.max(pct, count > 0 ? 2 : 0)}%` }}
        />
      </div>
      <span className="text-xs font-mono w-14 text-right text-muted-foreground">{count} <span className="text-[10px]">({pct}%)</span></span>
    </div>
  );
}
