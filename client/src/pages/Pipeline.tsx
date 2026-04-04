import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { GitBranch, DollarSign, Users, TrendingUp } from "lucide-react";
import { useLocation } from "wouter";

const STAGE_ORDER = [
  "new_lead",
  "contacted",
  "quote_sent",
  "paid_proof_needed",
  "proof_sent",
  "approved",
  "ready",
  "delivered",
  "not_qualified",
];

const STAGE_LABELS: Record<string, string> = {
  new_lead: "New Lead",
  contacted: "Contacted",
  quote_sent: "Quote Sent",
  paid_proof_needed: "Paid - Proof",
  proof_sent: "Proof Sent",
  approved: "Approved",
  ready: "Ready",
  delivered: "Delivered",
  not_qualified: "Not Qualified",
};

const STAGE_COLORS: Record<string, string> = {
  new_lead: "border-t-blue-500",
  contacted: "border-t-amber-500",
  quote_sent: "border-t-violet-500",
  paid_proof_needed: "border-t-orange-500",
  proof_sent: "border-t-pink-500",
  approved: "border-t-emerald-500",
  ready: "border-t-lime-500",
  delivered: "border-t-green-600",
  not_qualified: "border-t-gray-400",
};

const STAGE_DOT: Record<string, string> = {
  new_lead: "bg-blue-500",
  contacted: "bg-amber-500",
  quote_sent: "bg-violet-500",
  paid_proof_needed: "bg-orange-500",
  proof_sent: "bg-pink-500",
  approved: "bg-emerald-500",
  ready: "bg-lime-500",
  delivered: "bg-green-600",
  not_qualified: "bg-gray-400",
};

export default function Pipeline() {
  const { data: stats, isLoading } = trpc.pipeline.stats.useQuery();
  const { data: allLeads, isLoading: leadsLoading } = trpc.leads.list.useQuery();
  const [, setLocation] = useLocation();

  const totalLeads = stats?.reduce((sum, s) => sum + s.count, 0) || 0;
  const totalValue = stats?.reduce((sum, s) => sum + parseFloat(s.totalValue || "0"), 0) || 0;
  const activeLeads = stats?.filter(s => s.stage !== "not_qualified" && s.stage !== "delivered").reduce((sum, s) => sum + s.count, 0) || 0;

  // Group leads by stage, sorted by score desc
  const leadsByStage: Record<string, NonNullable<typeof allLeads>> = {};
  if (allLeads) {
    for (const lead of allLeads) {
      const stage = lead.pipelineStage || "new_lead";
      if (!leadsByStage[stage]) leadsByStage[stage] = [];
      leadsByStage[stage]!.push(lead);
    }
    // Sort each stage by score descending
    for (const stage of Object.keys(leadsByStage)) {
      leadsByStage[stage]!.sort((a, b) => (b.opportunityScore || 0) - (a.opportunityScore || 0));
    }
  }

  // Build ordered stages from stats
  const orderedStages = STAGE_ORDER.filter(s => {
    const stat = stats?.find(st => st.stage === s);
    return stat && stat.count > 0;
  });

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header with summary stats */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <GitBranch className="h-6 w-6" /> Pipeline
          </h1>
          <p className="text-muted-foreground mt-1">Bulk Printing Pipeline</p>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <Users className="h-3.5 w-3.5" /> Active Leads
              </div>
              <p className="text-2xl font-bold">{activeLeads}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <DollarSign className="h-3.5 w-3.5" /> Pipeline Value
              </div>
              <p className="text-2xl font-bold">${totalValue.toLocaleString()}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <TrendingUp className="h-3.5 w-3.5" /> Conversion
              </div>
              <p className="text-2xl font-bold">
                {totalLeads > 0 ? Math.round(((stats?.find(s => s.stage === "delivered")?.count || 0) / totalLeads) * 100) : 0}%
              </p>
              <p className="text-xs text-muted-foreground">{stats?.find(s => s.stage === "delivered")?.count || 0} delivered</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <Users className="h-3.5 w-3.5" /> Total Leads
              </div>
              <p className="text-2xl font-bold">{totalLeads}</p>
            </CardContent>
          </Card>
        </div>

        {/* Kanban board */}
        {isLoading || leadsLoading ? (
          <div className="flex gap-3 overflow-x-auto pb-4">
            {[1,2,3,4,5].map(i => <Skeleton key={i} className="h-64 w-56 shrink-0" />)}
          </div>
        ) : orderedStages.length > 0 ? (
          <div className="flex gap-3 overflow-x-auto pb-4 -mx-2 px-2">
            {orderedStages.map((stageKey) => {
              const stat = stats?.find(s => s.stage === stageKey);
              const stageLeads = leadsByStage[stageKey] || [];
              const value = parseFloat(stat?.totalValue || "0");
              const colorClass = STAGE_COLORS[stageKey] || "border-t-gray-300";
              const dotClass = STAGE_DOT[stageKey] || "bg-gray-400";

              return (
                <div
                  key={stageKey}
                  className={`shrink-0 w-52 bg-card rounded-lg border border-t-4 ${colorClass} flex flex-col max-h-[70vh]`}
                >
                  {/* Stage header */}
                  <div className="p-3 border-b">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`h-2 w-2 rounded-full ${dotClass}`} />
                      <span className="font-semibold text-sm">{STAGE_LABELS[stageKey] || stageKey}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{stat?.count || 0} leads</span>
                      {value > 0 && <span className="font-medium text-foreground">${value.toLocaleString()}</span>}
                    </div>
                  </div>

                  {/* Lead cards */}
                  <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
                    {stageLeads.slice(0, 15).map((lead) => (
                      <div
                        key={lead.id}
                        className="p-2 rounded-md bg-muted/40 hover:bg-muted/70 cursor-pointer transition-colors text-xs"
                        onClick={() => setLocation(`/leads/${lead.id}`)}
                      >
                        <p className="font-medium truncate">{lead.name || "Unknown"}</p>
                        {lead.businessName && (
                          <p className="text-muted-foreground truncate mt-0.5">{lead.businessName}</p>
                        )}
                        <div className="flex items-center justify-between mt-1">
                          {lead.pipelineValue ? (
                            <span className="text-green-700 font-medium">${Number(lead.pipelineValue).toLocaleString()}</span>
                          ) : (
                            <span />
                          )}
                          {lead.opportunityScore != null && lead.opportunityScore > 0 && (
                            <Badge
                              variant="outline"
                              className={`text-[10px] px-1.5 py-0 font-mono ${
                                lead.opportunityScore >= 80 ? "border-orange-400 text-orange-600" :
                                lead.opportunityScore >= 60 ? "border-amber-400 text-amber-600" :
                                "border-gray-300"
                              }`}
                            >
                              {lead.opportunityScore}
                            </Badge>
                          )}
                        </div>
                      </div>
                    ))}
                    {stageLeads.length > 15 && (
                      <p className="text-center text-[10px] text-muted-foreground py-1">
                        +{stageLeads.length - 15} more
                      </p>
                    )}
                    {stageLeads.length === 0 && (
                      <p className="text-center text-[10px] text-muted-foreground py-4">Empty</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <Card>
            <CardContent className="py-12 text-center">
              <GitBranch className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
              <p className="text-muted-foreground">No pipeline data yet.</p>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
