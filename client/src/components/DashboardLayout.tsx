import { useAuth } from "@/_core/hooks/useAuth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { getLoginUrl } from "@/const";
import { useIsMobile } from "@/hooks/useMobile";
import { trpc } from "@/lib/trpc";
import { LayoutDashboard, LogOut, PanelLeft, Users, Flame, BarChart3, Brain, FolderOpen, Settings, GitBranch, ScrollText, Webhook, WifiOff, Wifi } from "lucide-react";
import { CSSProperties, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from './DashboardLayoutSkeleton';
import { Button } from "./ui/button";
import { toast } from "sonner";

const menuItems = [
  { icon: LayoutDashboard, label: "Dashboard", path: "/", adminOnly: false },
  { icon: Flame, label: "Hot Leads", path: "/hot-leads", adminOnly: false },
  { icon: GitBranch, label: "Pipeline", path: "/pipeline", adminOnly: false },
  { icon: Users, label: "All Leads", path: "/leads", adminOnly: false },
  { icon: Brain, label: "AI Performance", path: "/ai-performance", adminOnly: false },
  { icon: ScrollText, label: "Brain Council Log", path: "/audit-log", adminOnly: false },
  { icon: Webhook, label: "Webhook Logs", path: "/webhook-logs", adminOnly: true },
  { icon: FolderOpen, label: "Knowledge Base", path: "/knowledge", adminOnly: true },
  { icon: Settings, label: "Settings", path: "/settings", adminOnly: true },
];

const SIDEBAR_WIDTH_KEY = "sidebar-width";
const DEFAULT_WIDTH = 280;
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return saved ? parseInt(saved, 10) : DEFAULT_WIDTH;
  });
  const { loading, user } = useAuth();

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
  }, [sidebarWidth]);

  if (loading) {
    return <DashboardLayoutSkeleton />
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center gap-8 p-8 max-w-md w-full">
          <div className="flex flex-col items-center gap-6">
            <h1 className="text-2xl font-semibold tracking-tight text-center">
              Sign in to continue
            </h1>
            <p className="text-sm text-muted-foreground text-center max-w-sm">
              Access to this dashboard requires authentication. Continue to launch the login flow.
            </p>
          </div>
          <Button
            onClick={() => {
              window.location.href = getLoginUrl();
            }}
            size="lg"
            className="w-full shadow-lg hover:shadow-xl transition-all"
          >
            Sign in
          </Button>
        </div>
      </div>
    );
  }

  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
        } as CSSProperties
      }
    >
      <DashboardLayoutContent setSidebarWidth={setSidebarWidth}>
        {children}
      </DashboardLayoutContent>
    </SidebarProvider>
  );
}

type DashboardLayoutContentProps = {
  children: React.ReactNode;
  setSidebarWidth: (width: number) => void;
};

function DashboardLayoutContent({
  children,
  setSidebarWidth,
}: DashboardLayoutContentProps) {
  const { user, logout } = useAuth();
  const [location, setLocation] = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const isCollapsed = state === "collapsed";
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const activeMenuItem = menuItems.find(item => item.path === location);
  const isMobile = useIsMobile();

  // Go Offline / Go Online state
  const { data: aiStatus, refetch: refetchStatus } = trpc.system.getAiStatus.useQuery(undefined, {
    refetchInterval: 30000, // poll every 30s
  });
  const setAiOnline = trpc.system.setAiOnline.useMutation({
    onSuccess: (data) => {
      refetchStatus();
      if (data.isOnline) {
        toast.success("AI Messaging is now ONLINE — all senders are active.");
      } else {
        toast.warning("AI Messaging is now OFFLINE — no messages will be sent to leads.");
      }
    },
    onError: (err) => {
      toast.error(`Failed to update AI status: ${err.message}`);
    },
  });

  const isAiOnline = aiStatus?.isOnline !== false; // default to online

  useEffect(() => {
    if (isCollapsed) {
      setIsResizing(false);
    }
  }, [isCollapsed]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;

      const sidebarLeft = sidebarRef.current?.getBoundingClientRect().left ?? 0;
      const newWidth = e.clientX - sidebarLeft;
      if (newWidth >= MIN_WIDTH && newWidth <= MAX_WIDTH) {
        setSidebarWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, setSidebarWidth]);

  return (
    <>
      {/* Offline banner — shown at top of page when AI is offline */}
      {!isAiOnline && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-red-600 text-white text-center text-sm font-semibold py-2 px-4 flex items-center justify-center gap-2">
          <WifiOff className="h-4 w-4 shrink-0" />
          <span>AI Messaging is OFFLINE — no messages are being sent to leads.</span>
          {user?.role === "admin" && (
            <button
              className="ml-3 underline hover:no-underline text-white font-bold"
              onClick={() => setAiOnline.mutate({ online: true })}
            >
              Go Online
            </button>
          )}
        </div>
      )}

      <div className={`flex h-screen ${!isAiOnline ? "pt-9" : ""}`}>
        <div className="relative" ref={sidebarRef}>
          <Sidebar
            collapsible="icon"
            className="border-r-0"
            disableTransition={isResizing}
          >
            <SidebarHeader className="h-16 justify-center">
              <div className="flex items-center gap-3 px-2 transition-all w-full">
                <button
                  onClick={toggleSidebar}
                  className="h-8 w-8 flex items-center justify-center hover:bg-accent rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring shrink-0"
                  aria-label="Toggle navigation"
                >
                  <PanelLeft className="h-4 w-4 text-muted-foreground" />
                </button>
                {!isCollapsed ? (
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-semibold tracking-tight truncate">
                      Adorb Outreach
                    </span>
                  </div>
                ) : null}
              </div>
            </SidebarHeader>

            <SidebarContent className="gap-0">
              <SidebarMenu className="px-2 py-1">
                {menuItems.filter(item => !item.adminOnly || user?.role === 'admin').map(item => {
                  const isActive = location === item.path;
                  return (
                    <SidebarMenuItem key={item.path}>
                      <SidebarMenuButton
                        isActive={isActive}
                        onClick={() => setLocation(item.path)}
                        tooltip={item.label}
                        className={`h-10 transition-all font-normal`}
                      >
                        <item.icon
                          className={`h-4 w-4 ${isActive ? "text-primary" : ""}`}
                        />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarContent>

            <SidebarFooter className="p-3 gap-2">
              {/* Go Offline / Go Online button — admin only */}
              {user?.role === "admin" && (
                <button
                  onClick={() => setAiOnline.mutate({ online: !isAiOnline })}
                  disabled={setAiOnline.isPending}
                  title={isAiOnline ? "Click to pause all AI messaging" : "Click to resume AI messaging"}
                  className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium w-full transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-ring
                    ${isAiOnline
                      ? "bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-400"
                      : "bg-red-500/15 text-red-700 hover:bg-red-500/25 dark:text-red-400"
                    }
                    group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-2
                  `}
                >
                  {isAiOnline
                    ? <Wifi className="h-4 w-4 shrink-0" />
                    : <WifiOff className="h-4 w-4 shrink-0" />
                  }
                  <span className="group-data-[collapsible=icon]:hidden">
                    {setAiOnline.isPending
                      ? "Updating..."
                      : isAiOnline
                        ? "AI Online"
                        : "AI Offline"
                    }
                  </span>
                </button>
              )}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="flex items-center gap-3 rounded-lg px-1 py-1 hover:bg-accent/50 transition-colors w-full text-left group-data-[collapsible=icon]:justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <Avatar className="h-9 w-9 border shrink-0">
                      <AvatarFallback className="text-xs font-medium">
                        {user?.name?.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0 group-data-[collapsible=icon]:hidden">
                      <p className="text-sm font-medium truncate leading-none">
                        {user?.name || "-"}
                      </p>
                      <p className="text-xs text-muted-foreground truncate mt-1.5">
                        {user?.email || "-"}
                      </p>
                    </div>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem
                    onClick={logout}
                    className="cursor-pointer text-destructive focus:text-destructive"
                  >
                    <LogOut className="mr-2 h-4 w-4" />
                    <span>Sign out</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarFooter>
          </Sidebar>
          <div
            className={`absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/20 transition-colors ${isCollapsed ? "hidden" : ""}`}
            onMouseDown={() => {
              if (isCollapsed) return;
              setIsResizing(true);
            }}
            style={{ zIndex: 50 }}
          />
        </div>

        <SidebarInset>
          {isMobile && (
            <div className="flex border-b h-14 items-center justify-between bg-background/95 px-2 backdrop-blur supports-[backdrop-filter]:backdrop-blur sticky top-0 z-40">
              <div className="flex items-center gap-2">
                <SidebarTrigger className="h-9 w-9 rounded-lg bg-background" />
                <div className="flex items-center gap-3">
                  <div className="flex flex-col gap-1">
                    <span className="tracking-tight text-foreground">
                      {activeMenuItem?.label ?? "Menu"}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}
          <main className="flex-1 p-4">{children}</main>
        </SidebarInset>
      </div>
    </>
  );
}
