import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Flame, Users, Brain, TrendingUp, MessageSquare, UserCheck } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

export default function Home() {
  const { data: perf, isLoading: perfLoading } = trpc.ai.performance.useQuery();
  const { data: pipelineStats, isLoading: pipeLoading } = trpc.pipeline.stats.useQuery();
  const { data: hotLeads, isLoading: hotLoading } = trpc.leads.hot.useQuery();
  const { data: agentWork, isLoading: agentLoading } = trpc.agents.workload.useQuery();

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
