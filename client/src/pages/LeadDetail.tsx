import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Mail, Phone, Globe, Building2, Brain, MessageSquare, UserCheck, HandMetal, DollarSign, StickyNote, FileSearch, CalendarClock } from "lucide-react";
import { useLocation, useParams } from "wouter";
import { toast } from "sonner";

export default function LeadDetail() {
  const params = useParams<{ id: string }>();
  const leadId = parseInt(params.id || "0");
  const { data, isLoading } = trpc.leads.detail.useQuery({ id: leadId }, { enabled: leadId > 0 });
  const [, setLocation] = useLocation();
  const toggleTakeover = trpc.leads.toggleHumanTakeover.useMutation({
    onSuccess: () => toast.success("Updated"),
  });

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="space-y-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64 w-full" />
        </div>
      </DashboardLayout>
    );
  }

  if (!data) {
    return (
      <DashboardLayout>
        <div className="text-center py-12">
          <p className="text-muted-foreground">Lead not found</p>
          <Button variant="outline" className="mt-4" onClick={() => setLocation("/leads")}>Back to Leads</Button>
        </div>
      </DashboardLayout>
    );
  }

  const { lead, history, events, aiState } = data;
  const isHumanTakeover = lead.humanTakeover === 1;

  // Parse research data
  const research = lead.researchData as { summary?: string; businessType?: string; potentialNeeds?: string[]; notes?: string } | null;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => setLocation("/leads")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{lead.name || "Unknown Lead"}</h1>
            <p className="text-muted-foreground">{lead.businessName || "No business name"}</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Badge variant={isHumanTakeover ? "destructive" : "default"}>
              {isHumanTakeover ? "Human Mode" : "AI Active"}
            </Badge>
            <Badge variant="outline" className="font-mono">{lead.opportunityScore ?? 0}</Badge>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: Contact Info + AI State + Extra Context */}
          <div className="space-y-4">
            <Card>
              <CardHeader><CardTitle className="text-base">Contact Info</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                {lead.email && <div className="flex items-center gap-2"><Mail className="h-4 w-4 text-muted-foreground" /><span>{lead.email}</span></div>}
                {lead.phone && <div className="flex items-center gap-2"><Phone className="h-4 w-4 text-muted-foreground" /><span>{lead.phone}</span></div>}
                {lead.website && <div className="flex items-center gap-2"><Globe className="h-4 w-4 text-muted-foreground" /><a href={lead.website} target="_blank" rel="noopener" className="text-primary hover:underline truncate">{lead.website}</a></div>}
                {lead.businessName && <div className="flex items-center gap-2"><Building2 className="h-4 w-4 text-muted-foreground" /><span>{lead.businessName}</span></div>}
                <div className="pt-2 border-t space-y-1">
                  <p className="text-xs text-muted-foreground">Stage: <span className="font-medium text-foreground">{lead.pipelineStage || "New Lead"}</span></p>
                  <p className="text-xs text-muted-foreground">Source: <span className="font-medium text-foreground">{lead.source || "Unknown"}</span></p>
                  <p className="text-xs text-muted-foreground">Segment: <span className="font-medium text-foreground">{lead.omnisendSegment || "Unclassified"}</span></p>
                  {lead.assignedAgent ? <p className="text-xs text-muted-foreground">Agent: <span className="font-medium text-foreground">{lead.assignedAgent}</span></p> : null}
                  <p className="text-xs text-muted-foreground">Pipeline Value: <span className="font-medium text-foreground">${(lead as any).pipelineValue || lead.opportunityValue || "0"}</span></p>
                  {lead.nextFollowUpAt && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <CalendarClock className="h-3 w-3" />
                      Next Outreach: <span className={`font-medium ${
                        new Date(lead.nextFollowUpAt) <= new Date() ? "text-red-600" : "text-foreground"
                      }`}>{new Date(lead.nextFollowUpAt).toLocaleString()}</span>
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Extra Context / Research Card */}
            <Card>
              <CardHeader><CardTitle className="text-base flex items-center gap-2"><FileSearch className="h-4 w-4" />Extra Context</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                {research && research.summary ? (
                  <>
                    <p className="text-muted-foreground">{research.summary}</p>
                    {research.businessType && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">Business Type:</span>
                        <Badge variant="outline" className="text-xs">{research.businessType}</Badge>
                      </div>
                    )}
                    {research.potentialNeeds && research.potentialNeeds.length > 0 && (
                      <div>
                        <span className="text-xs text-muted-foreground">Potential Needs:</span>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {research.potentialNeeds.map((need, i) => (
                            <Badge key={i} variant="secondary" className="text-xs">{need}</Badge>
                          ))}
                        </div>
                      </div>
                    )}
                    {research.notes && (
                      <p className="text-xs text-muted-foreground mt-2 italic">{research.notes}</p>
                    )}
                  </>
                ) : (
                  <p className="text-muted-foreground text-xs">No research context yet. AI will generate this when the lead is first engaged.</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base flex items-center gap-2"><Brain className="h-4 w-4" />AI State</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                {aiState ? (
                  <>
                    <p><span className="text-muted-foreground">Last Angle:</span> {aiState.lastAngleUsed || "None"}</p>
                    <p><span className="text-muted-foreground">Framework:</span> {aiState.lastFrameworkUsed || "None"}</p>
                    <p><span className="text-muted-foreground">Messages Sent:</span> {aiState.messageCount || 0}</p>
                    <p><span className="text-muted-foreground">Objections:</span> {typeof aiState.objectionsRaised === 'string' ? aiState.objectionsRaised : JSON.stringify(aiState.objectionsRaised) || "None"}</p>
                  </>
                ) : (
                  <p className="text-muted-foreground">No AI interaction yet</p>
                )}
              </CardContent>
            </Card>

            <Button
              variant={isHumanTakeover ? "default" : "destructive"}
              className="w-full"
              onClick={() => toggleTakeover.mutate({ id: lead.id, takeover: !isHumanTakeover })}
              disabled={toggleTakeover.isPending}
            >
              <HandMetal className="h-4 w-4 mr-2" />
              {isHumanTakeover ? "Re-enable AI" : "Take Over (Pause AI)"}
            </Button>
          </div>

          {/* Right: Conversation History */}
          <div className="lg:col-span-2">
            <Card className="h-full">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <MessageSquare className="h-4 w-4" /> Conversation History
                </CardTitle>
              </CardHeader>
              <CardContent>
                {history && history.length > 0 ? (
                  <div className="space-y-3 max-h-[600px] overflow-y-auto pr-2">
                    {[...history].reverse().map((msg) => (
                      <div key={msg.id} className={`flex ${msg.direction === "outbound" ? "justify-end" : "justify-start"}`}>
                        <div className={`max-w-[80%] rounded-lg p-3 text-sm ${
                          msg.direction === "outbound"
                            ? msg.senderType === "ai"
                              ? "bg-primary/10 text-foreground border border-primary/20"
                              : "bg-blue-50 text-foreground border border-blue-200"
                            : "bg-muted"
                        }`}>
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs font-medium">
                              {msg.senderType === "ai" ? `AI (${msg.senderName || "Sarah"})` : msg.senderType === "human" ? "Agent" : "Lead"}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {msg.channel || "SMS"}
                            </span>
                          </div>
                          <p className="whitespace-pre-wrap">{msg.messageBody}</p>
                          <p className="text-xs text-muted-foreground mt-1">
                            {msg.timestamp ? new Date(msg.timestamp).toLocaleString() : ""}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-8">
                    <MessageSquare className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
                    <p className="text-sm text-muted-foreground">No messages yet</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Pipeline Events */}
        {events && events.length > 0 && (
          <Card>
            <CardHeader><CardTitle className="text-base">Pipeline History</CardTitle></CardHeader>
            <CardContent>
              <div className="space-y-2">
                {events.map((evt) => (
                  <div key={evt.id} className="flex items-center gap-3 text-sm">
                    <div className="w-2 h-2 rounded-full bg-primary shrink-0" />
                    <span className="text-muted-foreground">{evt.fromStage || "—"}</span>
                    <span>→</span>
                    <span className="font-medium">{evt.toStage}</span>
                    <Badge variant="outline" className="text-xs ml-auto">{evt.triggeredBy}</Badge>
                    <span className="text-xs text-muted-foreground">{evt.timestamp ? new Date(evt.timestamp).toLocaleString() : ""}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
