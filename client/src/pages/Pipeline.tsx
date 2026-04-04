import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { GitBranch } from "lucide-react";

const STAGE_COLORS: Record<string, string> = {
  "New Lead": "bg-blue-100 text-blue-800",
  "Contacted": "bg-yellow-100 text-yellow-800",
  "Qualified": "bg-emerald-100 text-emerald-800",
  "Quote Sent": "bg-violet-100 text-violet-800",
  "Paid - Proof Needed": "bg-orange-100 text-orange-800",
  "Proof Sent": "bg-pink-100 text-pink-800",
  "In Production": "bg-cyan-100 text-cyan-800",
  "Ready": "bg-lime-100 text-lime-800",
  "Delivered": "bg-green-100 text-green-800",
};

export default function Pipeline() {
  const { data: stats, isLoading } = trpc.pipeline.stats.useQuery();
  const { data: allLeads, isLoading: leadsLoading } = trpc.leads.list.useQuery();

  const totalLeads = stats?.reduce((sum, s) => sum + s.count, 0) || 0;
  const totalValue = stats?.reduce((sum, s) => sum + parseFloat(s.totalValue || "0"), 0) || 0;

  // Group leads by stage
  const leadsByStage: Record<string, typeof allLeads> = {};
  if (allLeads) {
    for (const lead of allLeads) {
      const stage = lead.pipelineStage || "New Lead";
      if (!leadsByStage[stage]) leadsByStage[stage] = [];
      leadsByStage[stage]!.push(lead);
    }
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <GitBranch className="h-6 w-6" /> Pipeline
            </h1>
            <p className="text-muted-foreground mt-1">{totalLeads} leads — ${totalValue.toLocaleString()} total value</p>
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-4">{[1,2,3].map(i => <Skeleton key={i} className="h-24 w-full" />)}</div>
        ) : stats && stats.length > 0 ? (
          <div className="space-y-4">
            {stats.map((stage) => {
              const stageLeads = leadsByStage[stage.stage || "Unknown"] || [];
              const colorClass = STAGE_COLORS[stage.stage || ""] || "bg-gray-100 text-gray-800";
              return (
                <Card key={stage.stage || "unknown"}>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base flex items-center gap-2">
                        <Badge className={`${colorClass} border-0`}>{stage.stage || "Unknown"}</Badge>
                      </CardTitle>
                      <div className="flex items-center gap-3 text-sm">
                        <span className="text-muted-foreground">{stage.count} leads</span>
                        <span className="font-medium">${parseFloat(stage.totalValue || "0").toLocaleString()}</span>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {stageLeads.length > 0 ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                        {stageLeads.slice(0, 6).map((lead) => (
                          <div key={lead.id} className="flex items-center justify-between p-2 rounded-md bg-muted/50 text-sm">
                            <div className="min-w-0">
                              <p className="font-medium truncate">{lead.name || "Unknown"}</p>
                              <p className="text-xs text-muted-foreground truncate">{lead.businessName || ""}</p>
                            </div>
                            {lead.opportunityScore != null && (
                              <Badge variant="outline" className="ml-2 shrink-0 font-mono text-xs">{lead.opportunityScore}</Badge>
                            )}
                          </div>
                        ))}
                        {stageLeads.length > 6 && (
                          <div className="flex items-center justify-center p-2 text-xs text-muted-foreground">
                            +{stageLeads.length - 6} more
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">No leads in this stage</p>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : (
          <Card>
            <CardContent className="py-12 text-center">
              <GitBranch className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
              <p className="text-muted-foreground">No pipeline data yet. Connect GHL and sync contacts to see your pipeline.</p>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
