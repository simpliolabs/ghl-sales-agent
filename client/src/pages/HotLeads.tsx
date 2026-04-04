import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Flame, Mail, Phone, Globe, Building2 } from "lucide-react";
import { useLocation } from "wouter";

export default function HotLeads() {
  const { data: leads, isLoading } = trpc.leads.hot.useQuery();
  const [, setLocation] = useLocation();

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Flame className="h-6 w-6 text-orange-500" /> Hot Leads
          </h1>
          <p className="text-muted-foreground mt-1">Leads scoring 80+ — ready to close</p>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[1,2,3,4].map(i => <Skeleton key={i} className="h-40 w-full rounded-lg" />)}
          </div>
        ) : leads && leads.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {leads.map((lead) => (
              <Card
                key={lead.id}
                className="cursor-pointer hover:shadow-md transition-shadow"
                onClick={() => setLocation(`/leads/${lead.id}`)}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">{lead.name || "Unknown"}</CardTitle>
                    <div className="flex items-center gap-2">
                      <Badge variant={lead.opportunityScore! >= 90 ? "destructive" : "default"} className="font-mono">
                        {lead.opportunityScore}
                      </Badge>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2 text-sm">
                    {lead.businessName && (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Building2 className="h-3.5 w-3.5" />
                        <span>{lead.businessName}</span>
                      </div>
                    )}
                    {lead.email && (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Mail className="h-3.5 w-3.5" />
                        <span>{lead.email}</span>
                      </div>
                    )}
                    {lead.phone && (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Phone className="h-3.5 w-3.5" />
                        <span>{lead.phone}</span>
                      </div>
                    )}
                    {lead.website && (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Globe className="h-3.5 w-3.5" />
                        <span className="truncate">{lead.website}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between pt-2 border-t mt-2">
                      <span className="text-xs text-muted-foreground">
                        Stage: {lead.pipelineStage || "New Lead"}
                      </span>
                      {lead.assignedAgent && (
                        <Badge variant="outline" className="text-xs">{lead.assignedAgent}</Badge>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="py-12 text-center">
              <Flame className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
              <p className="text-muted-foreground">No hot leads yet. The AI will score leads as conversations flow in.</p>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
