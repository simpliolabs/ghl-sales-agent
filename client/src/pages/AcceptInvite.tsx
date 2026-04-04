import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getLoginUrl } from "@/const";
import { UserPlus, CheckCircle, XCircle, Clock } from "lucide-react";
import { useParams } from "wouter";
import { toast } from "sonner";
import { useLocation } from "wouter";

export default function AcceptInvite() {
  const { token } = useParams<{ token: string }>();
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();

  const { data: validation, isLoading } = trpc.invites.validate.useQuery(
    { token: token || "" },
    { enabled: !!token }
  );

  const acceptMutation = trpc.invites.accept.useMutation({
    onSuccess: (data) => {
      toast.success(`Welcome! You now have ${data.role} access.`);
      setTimeout(() => setLocation("/"), 1500);
    },
    onError: (e) => toast.error(e.message),
  });

  if (authLoading || isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <Card className="w-full max-w-md">
          <CardContent className="flex items-center justify-center py-12">
            <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!validation?.valid) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4">
              {validation?.expired ? (
                <Clock className="h-12 w-12 text-amber-500" />
              ) : (
                <XCircle className="h-12 w-12 text-destructive" />
              )}
            </div>
            <CardTitle>
              {validation?.expired ? "Invite Expired" : "Invalid Invite"}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-center">
            <p className="text-muted-foreground mb-4">
              {validation?.expired
                ? "This invite link has expired. Please ask your admin for a new one."
                : "This invite link is invalid or has already been used."}
            </p>
            <Button variant="outline" onClick={() => setLocation("/")}>
              Go to Dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4">
              <UserPlus className="h-12 w-12 text-primary" />
            </div>
            <CardTitle>You're Invited to Adorb Outreach</CardTitle>
          </CardHeader>
          <CardContent className="text-center space-y-4">
            <p className="text-muted-foreground">
              You've been invited as a <Badge variant={validation.role === 'admin' ? 'default' : 'secondary'}>{validation.role}</Badge>
            </p>
            <p className="text-sm text-muted-foreground">Sign in to accept your invitation.</p>
            <Button
              onClick={() => { window.location.href = getLoginUrl(`/invite/${token}`); }}
              size="lg"
              className="w-full"
            >
              Sign in to Accept
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4">
            <CheckCircle className="h-12 w-12 text-green-500" />
          </div>
          <CardTitle>Accept Your Invitation</CardTitle>
        </CardHeader>
        <CardContent className="text-center space-y-4">
          <p className="text-muted-foreground">
            Welcome, <strong>{user.name}</strong>! You've been invited as a{" "}
            <Badge variant={validation.role === 'admin' ? 'default' : 'secondary'}>{validation.role}</Badge>
          </p>
          <p className="text-sm text-muted-foreground">
            {validation.role === "admin"
              ? "As an admin, you'll have full access to all settings, AI configuration, and team management."
              : "As a viewer, you'll be able to see the dashboard, leads, pipeline, and AI performance."}
          </p>
          <Button
            onClick={() => acceptMutation.mutate({ token: token || "" })}
            disabled={acceptMutation.isPending}
            size="lg"
            className="w-full"
          >
            {acceptMutation.isPending ? "Accepting..." : "Accept Invitation"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
