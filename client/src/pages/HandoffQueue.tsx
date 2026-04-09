import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  HandMetal, Clock, AlertTriangle, ArrowRight, User, Building2,
  Phone, Mail, RefreshCw, Bot
} from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";

export default function HandoffQueue() {
  const { data, isLoading, refetch } = trpc.leads.handoffQueue.useQuery();
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();

  const releaseToAi = trpc.leads.toggleHumanTakeover.useMutation({
    onSuccess: () => {
      toast.success("Released back to AI");
      utils.leads.handoffQueue.invalidate();
    },
  });

  const staleCount = data?.filter(l => l.isStale).length || 0;
  const overdueCount = data?.filter(l => l.isOverdue).length || 0;
  const totalCount = data?.length || 0;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <HandMetal className="h-6 w-6" /> Agent Handoff Queue
            </h1>
            <p className="text-muted-foreground text-sm mt-1">
              Leads currently in Human Mode — agents must act or release back to AI
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="h-3 w-3 mr-1" /> Refresh
          </Button>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Total in Queue</p>
                  <p className="text-3xl font-bold">{totalCount}</p>
                </div>
                <HandMetal className="h-8 w-8 text-muted-foreground/30" />
              </div>
            </CardContent>
          </Card>
          <Card className={staleCount > 0 ? "border-amber-500/50" : ""}>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Stale (&gt;24hr silent)</p>
                  <p className="text-3xl font-bold text-amber-600">{staleCount}</p>
                </div>
                <Clock className="h-8 w-8 text-amber-500/30" />
              </div>
              {staleCount > 0 && (
                <p className="text-xs text-amber-600 mt-2">
                  Supervisor will auto-release these if no agent activity
                </p>
              )}
            </CardContent>
          </Card>
          <Card className={overdueCount > 0 ? "border-red-500/50" : ""}>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Overdue Schedule</p>
                  <p className="text-3xl font-bold text-red-600">{overdueCount}</p>
                </div>
                <AlertTriangle className="h-8 w-8 text-red-500/30" />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Queue Table */}
        {isLoading ? (
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
          </div>
        ) : !data || data.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Bot className="h-12 w-12 text-muted-foreground/20 mx-auto mb-3" />
              <p className="text-lg font-medium">Queue is empty</p>
              <p className="text-sm text-muted-foreground mt-1">All leads are being managed by AI</p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Leads in Human Mode</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="pb-3 font-medium text-muted-foreground">Lead</th>
                      <th className="pb-3 font-medium text-muted-foreground">Stage</th>
                      <th className="pb-3 font-medium text-muted-foreground">Agent</th>
                      <th className="pb-3 font-medium text-muted-foreground">Silent</th>
                      <th className="pb-3 font-medium text-muted-foreground">Next Outreach</th>
                      <th className="pb-3 font-medium text-muted-foreground">Score</th>
                      <th className="pb-3 font-medium text-muted-foreground text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.map((lead) => (
                      <tr key={lead.id} className={`border-b last:border-0 hover:bg-muted/50 transition-colors ${lead.isStale ? "bg-amber-50/50" : ""}`}>
                        <td className="py-3">
                          <button
                            onClick={() => setLocation(`/leads/${lead.id}`)}
                            className="text-left hover:text-primary transition-colors"
                          >
                            <div className="flex items-center gap-2">
                              <User className="h-4 w-4 text-muted-foreground shrink-0" />
                              <div className="min-w-0">
                                <p className="font-medium truncate max-w-[180px]">{lead.name || "Unknown"}</p>
                                {lead.businessName && (
                                  <p className="text-xs text-muted-foreground truncate max-w-[180px] flex items-center gap-1">
                                    <Building2 className="h-3 w-3" /> {lead.businessName}
                                  </p>
                                )}
                              </div>
                            </div>
                          </button>
                        </td>
                        <td className="py-3">
                          <Badge variant="outline" className="text-xs whitespace-nowrap">
                            {lead.pipelineStage || "New Lead"}
                          </Badge>
                        </td>
                        <td className="py-3">
                          <span className="text-xs">{lead.assignedAgent || "—"}</span>
                        </td>
                        <td className="py-3">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="flex items-center gap-1 cursor-help">
                                {lead.isStale ? (
                                  <AlertTriangle className="h-3 w-3 text-amber-500" />
                                ) : (
                                  <Clock className="h-3 w-3 text-muted-foreground" />
                                )}
                                <span className={`text-xs font-mono ${lead.isStale ? "text-amber-600 font-bold" : ""}`}>
                                  {lead.silentHours !== null ? `${lead.silentHours}h` : "—"}
                                </span>
                              </div>
                            </TooltipTrigger>
                            <TooltipContent>
                              {lead.lastAgentActivityAt
                                ? `Last agent activity: ${new Date(lead.lastAgentActivityAt).toLocaleString()}`
                                : "No agent activity recorded"}
                              {lead.isStale && " — STALE: Will be auto-released by Supervisor"}
                            </TooltipContent>
                          </Tooltip>
                        </td>
                        <td className="py-3">
                          {lead.nextFollowUpAt ? (
                            <span className={`text-xs ${lead.isOverdue ? "text-red-600 font-medium" : ""}`}>
                              {new Date(lead.nextFollowUpAt).toLocaleDateString()}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="py-3">
                          <Badge variant="outline" className="font-mono text-xs">
                            {lead.opportunityScore ?? 0}
                          </Badge>
                        </td>
                        <td className="py-3 text-right">
                          <div className="flex items-center gap-1 justify-end">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  onClick={() => setLocation(`/leads/${lead.id}`)}
                                >
                                  <ArrowRight className="h-3 w-3" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>View Lead Detail</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 text-xs"
                                  onClick={() => releaseToAi.mutate({ id: lead.id, takeover: false })}
                                  disabled={releaseToAi.isPending}
                                >
                                  <Bot className="h-3 w-3 mr-1" /> Release
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Release back to AI management</TooltipContent>
                            </Tooltip>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
