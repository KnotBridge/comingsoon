import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { OutreachAudience, OutreachSubPage, ComposePrefill } from "./outreach/types";
import AudiencesPage from "./outreach/AudiencesPage";
import ContactsPage from "./outreach/ContactsPage";
import ComposePage from "./outreach/ComposePage";
import SentLogPage from "./outreach/SentLogPage";
import RepliesPage from "./outreach/RepliesPage";
import TemplatesPage from "./outreach/TemplatesPage";
import MailboxPage from "./outreach/MailboxPage";
import ICPPage from "./outreach/ICPPage";
import TemplatePerformancePage from "./outreach/TemplatePerformancePage";
import FlowBuilder from "./flows/FlowBuilder";
import { Users, Send, MailOpen, GitBranch, Inbox, Radio, MessageSquareReply, FileText, Mail, Target, BarChart3 } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV: { id: OutreachSubPage; label: string; Icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "audiences", label: "Audiences", Icon: Users },
  { id: "contacts", label: "Contacts", Icon: Inbox },
  { id: "compose", label: "Compose", Icon: Send },
  { id: "templates", label: "Templates", Icon: FileText },
  { id: "flows", label: "Flows", Icon: GitBranch },
  { id: "sentlog", label: "Sent Log", Icon: MailOpen },
  { id: "mailbox", label: "Mailbox", Icon: Mail },
  { id: "performance", label: "Performance", Icon: BarChart3 },
];

export default function OutreachTab() {
  const [sub, setSub] = useState<OutreachSubPage>("audiences");
  const [audiences, setAudiences] = useState<OutreachAudience[]>([]);
  const [prefill, setPrefill] = useState<ComposePrefill | null>(null);
  const [navOpen, setNavOpen] = useState(false);

  const loadAudiences = useCallback(async () => {
    const { data } = await supabase.from("outreach_audiences").select("*").order("created_at", { ascending: false });
    setAudiences((data as OutreachAudience[]) || []);
  }, []);

  useEffect(() => { loadAudiences(); }, [loadAudiences]);

  const handleCompose = (emails: string[]) => {
    setPrefill({ emails });
    setSub("compose");
  };

  const handleFollowUp = (next: ComposePrefill) => {
    setPrefill(next);
    setSub("compose");
  };

  return (
    <div className="flex-1 flex gap-0 min-h-0 overflow-hidden">
      {/* Left sidebar — thin icon rail by default; expands over the content on hover
          to reveal the labels, then collapses back when the pointer leaves. */}
      <div className="w-14 flex-shrink-0 relative">
        <div
          onMouseEnter={() => setNavOpen(true)}
          onMouseLeave={() => setNavOpen(false)}
          className={cn(
            "absolute inset-y-0 left-0 z-30 border-r border-border flex flex-col gap-1 py-6 overflow-y-auto transition-[width] duration-200",
            navOpen ? "w-52 px-3 bg-card shadow-xl" : "w-14 px-2 bg-muted/20",
          )}
        >
          <p className={cn(
            "text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5 h-4",
            navOpen ? "px-2" : "justify-center",
          )}>
            <Radio className="w-3.5 h-3.5 shrink-0" />
            {navOpen && <span>Outreach</span>}
          </p>
          {NAV.map(({ id, label, Icon }) => (
            <button key={id} onClick={() => setSub(id)} title={!navOpen ? label : undefined}
              className={cn(
                "flex items-center gap-2.5 py-2 rounded-lg text-sm font-medium transition-colors w-full",
                navOpen ? "px-3 text-left" : "px-0 justify-center",
                sub === id ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
              )}>
              <Icon className="w-4 h-4 flex-shrink-0" />
              {navOpen && <span className="whitespace-nowrap">{label}</span>}
              {navOpen && id === "audiences" && audiences.length > 0 && (
                <span className="ml-auto text-xs text-muted-foreground font-normal">{audiences.length}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Main content — mailbox and flows fill the full height; the list pages get
          their own padded, scrollable area. */}
      {sub === "mailbox" ? (
        <div className="flex-1 min-w-0 flex min-h-0 overflow-hidden"><MailboxPage /></div>
      ) : sub === "flows" ? (
        <div className="flex-1 min-w-0 flex min-h-0 overflow-hidden"><FlowBuilder domain="outreach" /></div>
      ) : sub === "compose" ? (
        <div className="flex-1 min-w-0 flex min-h-0 overflow-hidden">
          <ComposePage audiences={audiences} prefill={prefill} onPrefillConsumed={() => setPrefill(null)} />
        </div>
      ) : sub === "audiences" ? (
        <div className="flex-1 min-w-0 flex min-h-0 overflow-hidden p-6">
          <AudiencesPage audiences={audiences} onRefresh={loadAudiences} />
        </div>
      ) : (
        <div className="flex-1 min-w-0 p-6 overflow-auto">
          {sub === "contacts" && <ContactsPage audiences={audiences} onCompose={handleCompose} />}
          {sub === "performance" && <TemplatePerformancePage />}
          {sub === "templates" && <TemplatesPage />}
          {sub === "sentlog" && <SentLogPage audiences={audiences} onFollowUp={handleFollowUp} />}
          {sub === "replies" && <RepliesPage audiences={audiences} />}
        </div>
      )}
    </div>
  );
}
