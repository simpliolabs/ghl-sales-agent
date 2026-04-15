import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ArrowLeft, Mail, Phone, Globe, Building2, Brain, MessageSquare,
  UserCheck, HandMetal, DollarSign, StickyNote, FileSearch, CalendarClock,
  ExternalLink, MailOpen, MousePointerClick, MailX, Calendar, Clock,
  AlertTriangle, Send, RefreshCw, BookOpen
} from "lucide-react";
import { useLocation, useParams } from "wouter";
import { toast } from "sonner";
import { useState } from "react";

export default function LeadDetail() {
  const params = useParams<{ id: string }>();
  const leadId = parseInt(params.id || "0");
  const { data, isLoading } = trpc.leads.detail.useQuery({ id: leadId }, { enabled: leadId > 0 });
  const { data: memoryFacts } = trpc.learning.leadMemory.useQuery({ leadId }, { enabled: leadId > 0 });
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const [showReschedule, setShowReschedule] = useState(false);
  const [rescheduleDate, setRescheduleDate] = useState("");
  const [rescheduleReason, setRescheduleReason] = useState("");

  const toggleTakeover = trpc.leads.toggleHumanTakeover.useMutation({
    onSuccess: () => { toast.success("Updated"); utils.leads.detail.invalidate({ id: leadId }); },
  });
  const reschedule = trpc.leads.reschedule.useMutation({
    onSuccess: (res) => {
      toast.success(`Rescheduled to ${new Date(res.scheduledAt).toLocaleString()}`);
      utils.leads.detail.invalidate({ id: leadId });
      setShowReschedule(false);
      setRescheduleDate("");
      setRescheduleReason("");
    },
    onError: (err) => toast.error(err.message),
  });

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="space-y-4">
          <Skeleton className="h-8 w-48" />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Skeleton className="h-96" />
            <Skeleton className="h-96 lg:col-span-2" />
          </div>
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
  const research = lead.researchData as { summary?: string; businessType?: string; potentialNeeds?: string[]; notes?: string } | null;
  const isOverdue = lead.nextFollowUpAt && new Date(lead.nextFollowUpAt) <= new Date();
  const ghlUrl = lead.ghlContactId ? `https://app.gohighlevel.com/v2/location/me/contacts/detail/${lead.ghlContactId}` : null;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4 flex-wrap">
          <Button variant="ghost" size="icon" onClick={() => setLocation("/leads")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold tracking-tight truncate">{lead.name || "Unknown Lead"}</h1>
            <p className="text-muted-foreground truncate">{lead.businessName || "No business name"}</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant={isHumanTakeover ? "destructive" : "default"}>
              {isHumanTakeover ? "Human Mode" : "AI Active"}
            </Badge>
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className="font-mono cursor-help">{lead.opportunityScore ?? 0}</Badge>
              </TooltipTrigger>
              <TooltipContent>Opportunity Score (0-100)</TooltipContent>
            </Tooltip>
            {ghlUrl && (
              <Button variant="outline" size="sm" asChild>
                <a href={ghlUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-3 w-3 mr-1" /> GHL
                </a>
              </Button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* ═══ LEFT COLUMN ═══ */}
          <div className="space-y-4">
            {/* Contact Info */}
            <Card>
              <CardHeader><CardTitle className="text-base">Contact Info</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                {lead.email && <div className="flex items-center gap-2"><Mail className="h-4 w-4 text-muted-foreground" /><span className="truncate">{lead.email}</span></div>}
                {lead.phone && <div className="flex items-center gap-2"><Phone className="h-4 w-4 text-muted-foreground" /><span>{lead.phone}</span></div>}
                {lead.website && <div className="flex items-center gap-2"><Globe className="h-4 w-4 text-muted-foreground" /><a href={lead.website} target="_blank" rel="noopener" className="text-primary hover:underline truncate">{lead.website}</a></div>}
                {lead.businessName && <div className="flex items-center gap-2"><Building2 className="h-4 w-4 text-muted-foreground" /><span>{lead.businessName}</span></div>}
                <div className="pt-2 border-t space-y-1.5">
                  <InfoRow label="Stage" value={lead.pipelineStage || "New Lead"} />
                  <InfoRow label="Source" value={lead.source || "Unknown"} />
                  <InfoRow label="Segment" value={lead.omnisendSegment || "Unclassified"} />
                  {lead.assignedAgent && <InfoRow label="Agent" value={lead.assignedAgent} />}
                  <InfoRow label="Pipeline Value" value={`$${(lead as any).pipelineValue || lead.opportunityValue || "0"}`} />
                </div>
              </CardContent>
            </Card>

            {/* Schedule & Outreach */}
            <Card className={isOverdue ? "border-red-500/50" : ""}>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <CalendarClock className="h-4 w-4" />
                  Schedule
                  {isOverdue && <Badge variant="destructive" className="text-[10px]">Overdue</Badge>}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {lead.nextFollowUpAt ? (
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-muted-foreground" />
                    <span className={isOverdue ? "text-red-600 font-medium" : ""}>
                      {new Date(lead.nextFollowUpAt).toLocaleString()}
                    </span>
                  </div>
                ) : (
                  <p className="text-muted-foreground text-xs flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" /> No outreach scheduled
                  </p>
                )}
                {lead.overrideBy && (
                  <p className="text-xs text-muted-foreground">
                    Last override by <span className="font-medium">{lead.overrideBy}</span>
                    {lead.overrideReason && <> — {lead.overrideReason}</>}
                  </p>
                )}
                {showReschedule ? (
                  <div className="space-y-2 pt-2 border-t">
                    <Input type="datetime-local" value={rescheduleDate} onChange={(e) => setRescheduleDate(e.target.value)} className="text-xs" />
                    <Input placeholder="Reason for reschedule" value={rescheduleReason} onChange={(e) => setRescheduleReason(e.target.value)} className="text-xs" />
                    <div className="flex gap-2">
                      <Button size="sm" className="flex-1" disabled={!rescheduleDate || !rescheduleReason || reschedule.isPending}
                        onClick={() => reschedule.mutate({ id: lead.id, nextFollowUpAt: new Date(rescheduleDate).toISOString(), reason: rescheduleReason })}>
                        {reschedule.isPending ? "Saving..." : "Confirm"}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setShowReschedule(false)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <Button size="sm" variant="outline" className="w-full" onClick={() => setShowReschedule(true)}>
                    <RefreshCw className="h-3 w-3 mr-1" /> Reschedule
                  </Button>
                )}
              </CardContent>
            </Card>

            {/* Email Engagement */}
            <Card>
              <CardHeader><CardTitle className="text-base flex items-center gap-2"><MailOpen className="h-4 w-4" />Email Engagement</CardTitle></CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-3 text-center">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="cursor-help">
                        <MailOpen className="h-4 w-4 mx-auto text-emerald-500 mb-1" />
                        <p className="text-lg font-bold">{(lead as any).emailOpens || 0}</p>
                        <p className="text-[10px] text-muted-foreground">Opens</p>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      {(lead as any).lastEmailOpenAt ? `Last opened: ${new Date((lead as any).lastEmailOpenAt).toLocaleString()}` : "No opens recorded"}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="cursor-help">
                        <MousePointerClick className="h-4 w-4 mx-auto text-blue-500 mb-1" />
                        <p className="text-lg font-bold">{(lead as any).emailClicks || 0}</p>
                        <p className="text-[10px] text-muted-foreground">Clicks</p>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      {(lead as any).lastEmailClickAt ? `Last clicked: ${new Date((lead as any).lastEmailClickAt).toLocaleString()}` : "No clicks recorded"}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="cursor-help">
                        <MailX className="h-4 w-4 mx-auto text-red-500 mb-1" />
                        <p className="text-lg font-bold">{(lead as any).emailBounces || 0}</p>
                        <p className="text-[10px] text-muted-foreground">Bounces</p>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      {(lead as any).emailUnsubscribed ? "⚠️ Unsubscribed from email" : "Not unsubscribed"}
                    </TooltipContent>
                  </Tooltip>
                </div>
                {(lead as any).emailUnsubscribed === 1 && (
                  <div className="mt-2 p-2 bg-red-50 rounded text-xs text-red-700 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" /> Lead has unsubscribed from email
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Appointment */}
            <Card>
              <CardHeader><CardTitle className="text-base flex items-center gap-2"><Calendar className="h-4 w-4" />Appointment</CardTitle></CardHeader>
              <CardContent className="text-sm">
                {(lead as any).nextAppointmentAt ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Calendar className="h-4 w-4 text-primary" />
                      <span className="font-medium">{new Date((lead as any).nextAppointmentAt).toLocaleString()}</span>
                    </div>
                    {(lead as any).appointmentStatus && (
                      <Badge variant={(lead as any).appointmentStatus === 'confirmed' ? 'default' : (lead as any).appointmentStatus === 'cancelled' ? 'destructive' : 'secondary'}>
                        {(lead as any).appointmentStatus}
                      </Badge>
                    )}
                  </div>
                ) : (
                  <p className="text-muted-foreground text-xs">No appointment scheduled</p>
                )}
              </CardContent>
            </Card>

            {/* Agent Notes */}
            <Card>
              <CardHeader><CardTitle className="text-base flex items-center gap-2"><StickyNote className="h-4 w-4" />Agent Notes</CardTitle></CardHeader>
              <CardContent className="text-sm">
                {(lead as any).lastAgentNote ? (
                  <div className="space-y-1">
                    <p className="whitespace-pre-wrap text-muted-foreground">{(lead as any).lastAgentNote}</p>
                    {(lead as any).lastAgentNoteAt && (
                      <p className="text-[10px] text-muted-foreground">{new Date((lead as any).lastAgentNoteAt).toLocaleString()}</p>
                    )}
                  </div>
                ) : (
                  <p className="text-muted-foreground text-xs">No agent notes. Notes added in GHL will appear here automatically.</p>
                )}
              </CardContent>
            </Card>

            {/* Research / Extra Context */}
            <Card>
              <CardHeader><CardTitle className="text-base flex items-center gap-2"><FileSearch className="h-4 w-4" />Research</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                {research && research.summary ? (
                  <>
                    <p className="text-muted-foreground">{research.summary}</p>
                    {research.businessType && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">Type:</span>
                        <Badge variant="outline" className="text-xs">{research.businessType}</Badge>
                      </div>
                    )}
                    {research.potentialNeeds && research.potentialNeeds.length > 0 && (
                      <div>
                        <span className="text-xs text-muted-foreground">Needs:</span>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {research.potentialNeeds.map((need, i) => (
                            <Badge key={i} variant="secondary" className="text-xs">{need}</Badge>
                          ))}
                        </div>
                      </div>
                    )}
                    {research.notes && <p className="text-xs text-muted-foreground mt-2 italic">{research.notes}</p>}
                  </>
                ) : (
                  <p className="text-muted-foreground text-xs">No research context yet. AI will generate this when the lead is first engaged.</p>
                )}
              </CardContent>
            </Card>

            {/* AI State */}
            <Card>
              <CardHeader><CardTitle className="text-base flex items-center gap-2"><Brain className="h-4 w-4" />AI State</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                {aiState ? (
                  <>
                    <InfoRow label="Last Angle" value={aiState.lastAngleUsed || "None"} />
                    <InfoRow label="Framework" value={aiState.lastFrameworkUsed || "None"} />
                    <InfoRow label="Messages Sent" value={String(aiState.messageCount || 0)} />
                    <InfoRow label="Objections" value={typeof aiState.objectionsRaised === 'string' ? aiState.objectionsRaised : JSON.stringify(aiState.objectionsRaised) || "None"} />
                  </>
                ) : (
                  <p className="text-muted-foreground">No AI interaction yet</p>
                )}
              </CardContent>
            </Card>

            {/* Human Takeover Toggle */}
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

          {/* ═══ RIGHT COLUMN: Conversation History ═══ */}
          <div className="lg:col-span-2">
            <Card className="h-full">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <MessageSquare className="h-4 w-4" /> Conversation History
                  {history && <Badge variant="outline" className="ml-2 text-xs">{history.length} messages</Badge>}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {history && history.length > 0 ? (
                  <div className="space-y-3 max-h-[700px] overflow-y-auto pr-2">
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
                            <Badge variant="outline" className="text-[10px] px-1 py-0">{msg.channel || "SMS"}</Badge>
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
                  <div className="text-center py-12">
                    <MessageSquare className="h-10 w-10 text-muted-foreground/20 mx-auto mb-3" />
                    <p className="text-sm text-muted-foreground">No messages yet</p>
                    <p className="text-xs text-muted-foreground mt-1">Messages will appear here as the AI engages this lead</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Lead Memory (Module 5B) */}
        {memoryFacts && memoryFacts.length > 0 && (
          <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><BookOpen className="h-4 w-4" />AI Memory — What the system knows about this lead</CardTitle></CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {memoryFacts.map((fact: any) => (
                  <div key={fact.id} className="flex items-start gap-2 text-sm rounded-md bg-muted/40 px-3 py-2">
                    <span className="text-xs font-medium text-muted-foreground shrink-0 min-w-[100px]">{fact.factKey.replace(/_/g, " ")}</span>
                    <span className="text-xs text-foreground">{fact.factValue}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

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

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <p className="text-xs text-muted-foreground">{label}: <span className="font-medium text-foreground">{value}</span></p>
  );
}
