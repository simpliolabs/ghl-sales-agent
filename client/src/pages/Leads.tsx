import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Users, Search, RefreshCw, CalendarClock } from "lucide-react";
import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

export default function Leads() {
  const { data: leads, isLoading, refetch } = trpc.leads.list.useQuery();
  const syncMutation = trpc.ghl.syncContacts.useMutation({
    onSuccess: (data) => {
      toast.success(`Synced ${data.contacts} contacts from GHL`);
      refetch();
    },
    onError: () => toast.error("Failed to sync contacts"),
  });
  const [search, setSearch] = useState("");
  const [, setLocation] = useLocation();

  const filtered = useMemo(() => {
    if (!leads) return [];
    if (!search) return leads;
    const q = search.toLowerCase();
    return leads.filter(l =>
      (l.name || "").toLowerCase().includes(q) ||
      (l.businessName || "").toLowerCase().includes(q) ||
      (l.email || "").toLowerCase().includes(q)
    );
  }, [leads, search]);

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Users className="h-6 w-6" /> All Leads
            </h1>
            <p className="text-muted-foreground mt-1">{leads?.length || 0} leads in system</p>
          </div>
          <Button onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending} variant="outline" size="sm">
            <RefreshCw className={`h-4 w-4 mr-2 ${syncMutation.isPending ? "animate-spin" : ""}`} />
            Sync from GHL
          </Button>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search leads by name, business, or email..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-10" />
        </div>

        {isLoading ? (
          <div className="space-y-2">{[1,2,3,4,5].map(i => <Skeleton key={i} className="h-16 w-full" />)}</div>
        ) : filtered.length > 0 ? (
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="text-left p-3 font-medium">Name</th>
                      <th className="text-left p-3 font-medium hidden sm:table-cell">Business</th>
                      <th className="text-left p-3 font-medium hidden md:table-cell">Email</th>
                      <th className="text-left p-3 font-medium">Stage</th>
                      <th className="text-center p-3 font-medium">Score</th>
                      <th className="text-left p-3 font-medium hidden lg:table-cell">Agent</th>
                      <th className="text-left p-3 font-medium">Next Outreach</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((lead) => (
                      <tr
                        key={lead.id}
                        className="border-b hover:bg-muted/30 cursor-pointer transition-colors"
                        onClick={() => setLocation(`/leads/${lead.id}`)}
                      >
                        <td className="p-3 font-medium">{lead.name || "Unknown"}</td>
                        <td className="p-3 text-muted-foreground hidden sm:table-cell">{lead.businessName || "—"}</td>
                        <td className="p-3 text-muted-foreground hidden md:table-cell">{lead.email || "—"}</td>
                        <td className="p-3">
                          <Badge variant="outline" className="text-xs">{lead.pipelineStage || "New Lead"}</Badge>
                        </td>
                        <td className="p-3 text-center">
                          <span className={`font-mono text-sm font-medium ${(lead.opportunityScore || 0) >= 80 ? "text-orange-600" : (lead.opportunityScore || 0) >= 50 ? "text-yellow-600" : "text-muted-foreground"}`}>
                            {lead.opportunityScore ?? "—"}
                          </span>
                        </td>
                        <td className="p-3 text-muted-foreground hidden lg:table-cell">{lead.assignedAgent || "—"}</td>
                        <td className="p-3">
                          {lead.nextFollowUpAt ? (
                            <span className={`flex items-center gap-1 text-xs whitespace-nowrap ${
                              new Date(lead.nextFollowUpAt) <= new Date()
                                ? "text-red-600 font-semibold"
                                : new Date(lead.nextFollowUpAt) <= new Date(Date.now() + 86400000)
                                  ? "text-amber-600 font-medium"
                                  : "text-muted-foreground"
                            }`}>
                              <CalendarClock className="h-3.5 w-3.5 shrink-0" />
                              {new Date(lead.nextFollowUpAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}{" "}
                              {new Date(lead.nextFollowUpAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground/40">Not scheduled</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="py-12 text-center">
              <Users className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
              <p className="text-muted-foreground">{search ? "No leads match your search." : "No leads yet. Click 'Sync from GHL' to import contacts."}</p>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
