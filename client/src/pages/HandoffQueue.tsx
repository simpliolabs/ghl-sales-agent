import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  HandMetal, Clock, AlertTriangle, ArrowRight, User, Building2,
  Phone, Mail, RefreshCw, Bot, Flag, Eye, CheckCircle2
} from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { useState } from "react";

export default function HandoffQueue() {
  const { data, isLoading, refetch } = trpc.leads.handoffQueue.useQuery();
  const { data: flagged, isLoading: flaggedLoading } = trpc.dashboard.flaggedMessages.useQuery();
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const [activeTab, setActiveTab] = useState("handoffs");

  const releaseToAi = trpc.leads.toggleHumanTakeover.useMutation({
    onSuccess: () => {
      toast.success("Released back to AI");
      utils.leads.handoffQueue.invalidate();
    },
  });

  const acknowledgeFlagged = trpc.dashboard.acknowledgeFlagged.useMutation({
    onSuccess: () => {
      toast.success("Message dismissed");
      utils.dashboard.flaggedMessages.invalidate();
    },
  });

  const staleCount = data?.filter(l => l.isStale).length || 0;
  const overdueCount = data?.filter(l => l.isOverdue).length || 0;
  const totalCount = data?.length || 0;
  const unacknowledgedFlagged = flagged?.filter((f: any) => !f.flagAcknowledged).length || 0;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Eye className="h-6 w-6" /> Review Queue
            </h1>
            <p className="text-muted-foreground text-sm mt-1">
              Items requiring human attention — handoffs and flagged AI messages
            </p>
          </div>
          <div className="flex items-center gap-2">
            {totalCount > 0 && <Badge variant="secondary" className="text-xs">{totalCount} handoff{totalCount !== 1 ? 's' : ''}</Badge>}
            {unacknowledgedFlagged > 0 && <Badge variant="destructive" className="text-xs">{unacknowledgedFlagged} flagged</Badge>}
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="handoffs" className="gap-1.5">
              <HandMetal className="h-3.5 w-3.5" />
              Agent Handoffs
              {totalCount > 0 && <Badge variant="secondary" className="ml-1 text-[10px] px-1.5">{totalCount}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="flagged" className="gap-1.5">
              <Flag className="h-3.5 w-3.5" />
              Flagged Messages
              {unacknowledgedFlagged > 0 && <Badge variant="destructive" className="ml-1 text-[10px] px-1.5">{unacknowledgedFlagged}</Badge>}
            </TabsTrigger>
          </TabsList>

          {/* ═══ AGENT HANDOFFS TAB ═══ */}
          <TabsContent value="handoffs" className="mt-4">
            {isLoading ? (
              <div className="space-y-3">
                {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-16 w-full" />)}
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
                          <th className="pb-3 font-medium text-muted-foreground">Score</th>
                          <th className="pb-3 font-medium text-muted-foreground text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.map((lead) => (
                          <tr key={lead.id} className={`border-b last:border-0 hover:bg-muted/50 transition-colors ${lead.isStale ? "bg-amber-50/50" : ""}`}>
                            <td className="py-3">
                              <button onClick={() => setLocation(`/leads/${lead.id}`)} className="text-left hover:text-primary transition-colors">
                                <div className="flex items-center gap-2">
                                  <User className="h-4 w-4 text-muted-foreground shrink-0" />
                                  <div className="min-w-0">
                                    <p className="font-medium truncate max-w-[180px]">{lead.name || "Unknown"}</p>
                                    {lead.businessName && <p className="text-xs text-muted-foreground truncate max-w-[180px]">{lead.businessName}</p>}
                                  </div>
                                </div>
                              </button>
                            </td>
                            <td className="py-3"><Badge variant="outline" className="text-xs">{lead.pipelineStage || "New Lead"}</Badge></td>
                            <td className="py-3"><span className="text-xs">{lead.assignedAgent || "—"}</span></td>
                            <td className="py-3">
                              <div className="flex items-center gap-1">
                                {lead.isStale ? <AlertTriangle className="h-3 w-3 text-amber-500" /> : <Clock className="h-3 w-3 text-muted-foreground" />}
                                <span className={`text-xs font-mono ${lead.isStale ? "text-amber-600 font-bold" : ""}`}>
                                  {lead.silentHours !== null ? `${lead.silentHours}h` : "—"}
                                </span>
                              </div>
                            </td>
                            <td className="py-3"><Badge variant="outline" className="font-mono text-xs">{lead.opportunityScore ?? 0}</Badge></td>
                            <td className="py-3 text-right">
                              <div className="flex items-center gap-1 justify-end">
                                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setLocation(`/leads/${lead.id}`)}>
                                  <ArrowRight className="h-3 w-3" />
                                </Button>
                                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => releaseToAi.mutate({ id: lead.id, takeover: false })} disabled={releaseToAi.isPending}>
                                  <Bot className="h-3 w-3 mr-1" /> Release
                                </Button>
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
          </TabsContent>

          {/* ═══ FLAGGED MESSAGES TAB ═══ */}
          <TabsContent value="flagged" className="mt-4">
            {flaggedLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-24 w-full" />)}
              </div>
            ) : flagged && flagged.length > 0 ? (
              <div className="space-y-3">
                {flagged.map((item: any) => (
                  <Card key={item.id} className={item.flagAcknowledged ? 'opacity-60' : 'border-orange-500/40'}>
                    <CardContent className="pt-4 pb-3">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <Flag className="h-3.5 w-3.5 text-orange-500 shrink-0" />
                            <span className="font-medium text-sm">{item.leadName || `Lead #${item.leadId}`}</span>
                            {item.businessName && <span className="text-xs text-muted-foreground">({item.businessName})</span>}
                            <Badge variant="outline" className="text-[10px]">{item.channel || 'email'}</Badge>
                            <Badge variant="secondary" className="text-[10px]">{item.trigger}</Badge>
                          </div>
                          <p className="text-xs text-orange-700 font-medium mb-1">{item.flagReason || 'Flagged for review'}</p>
                          {item.brainReasoning && <p className="text-xs text-muted-foreground line-clamp-2">{item.brainReasoning.substring(0, 200)}</p>}
                          <p className="text-[10px] text-muted-foreground mt-1.5">
                            {new Date(item.createdAt).toLocaleString()}
                            {item.outputGuardResult && item.outputGuardResult !== 'pass' && <span className="ml-2 text-red-600">Guard: {item.outputGuardResult}</span>}
                          </p>
                        </div>
                        <div className="flex flex-col gap-1.5 shrink-0">
                          {!item.flagAcknowledged && (
                            <Button size="sm" variant="outline" className="text-xs" onClick={() => acknowledgeFlagged.mutate({ id: item.id })} disabled={acknowledgeFlagged.isPending}>
                              Dismiss
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" className="text-xs" onClick={() => setLocation(`/leads/${item.leadId}`)}>
                            View Lead
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : (
              <Card>
                <CardContent className="py-12 text-center">
                  <CheckCircle2 className="h-10 w-10 text-emerald-500 mx-auto mb-3" />
                  <p className="font-medium">No flagged messages</p>
                  <p className="text-sm text-muted-foreground mt-1">All AI decisions passed review.</p>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
