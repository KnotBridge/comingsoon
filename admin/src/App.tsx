import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import OutreachTab from "@/components/admin/email/OutreachTab";
import SendersTab from "@/components/admin/email/SendersTab";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Server, LogOut, Lock, Loader2 } from "lucide-react";
import { toast } from "sonner";

const FLAG_KEY = "rnq-admin-ok";

/**
 * Access gate. The user types the shared code; a Netlify function verifies it
 * and returns a real Supabase admin session (kept in localStorage by the
 * supabase client). Data access then runs under that session so RLS applies.
 */
function Gate({ onUnlock }: { onUnlock: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch("/api/admin-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      if (!res.ok) {
        toast.error(res.status === 401 ? "Wrong code." : "Login failed. Try again.");
        return;
      }
      const { access_token, refresh_token } = await res.json();
      const { error } = await supabase.auth.setSession({ access_token, refresh_token });
      if (error) {
        toast.error("Could not start session.");
        return;
      }
      localStorage.setItem(FLAG_KEY, "1");
      onUnlock();
    } catch {
      toast.error("Network error.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-border bg-card p-8 shadow-sm"
      >
        <div className="flex flex-col items-center text-center mb-6">
          <div className="w-12 h-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center mb-3">
            <Lock className="w-6 h-6" />
          </div>
          <h1 className="text-lg font-semibold">R'NQ Mail Manager</h1>
          <p className="text-sm text-muted-foreground mt-1">Enter your access code to continue.</p>
        </div>
        <input
          autoFocus
          type="password"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Access code"
          className="w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          type="submit"
          disabled={busy || !code.trim()}
          className="mt-4 w-full rounded-lg bg-primary py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {busy && <Loader2 className="w-4 h-4 animate-spin" />}
          Unlock
        </button>
      </form>
    </div>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [sendersOpen, setSendersOpen] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      setUnlocked(!!data.session && localStorage.getItem(FLAG_KEY) === "1");
      setReady(true);
    })();
  }, []);

  const logout = async () => {
    await supabase.auth.signOut();
    localStorage.removeItem(FLAG_KEY);
    setUnlocked(false);
  };

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!unlocked) return <Gate onUnlock={() => setUnlocked(true)} />;

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      <div className="border-b bg-card shrink-0">
        <div className="px-5 flex items-center gap-4 py-2.5">
          <div className="flex items-center gap-2.5 shrink-0">
            <img src="/logo.png" alt="R'NQ" className="h-6 w-auto" />
            <span className="text-muted-foreground/40 text-lg leading-none">|</span>
            <span className="text-muted-foreground text-sm font-medium hidden lg:inline">
              Mail Manager
            </span>
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-3 shrink-0">
            <button
              onClick={() => setSendersOpen(true)}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            >
              <Server className="w-3.5 h-3.5" />
              Senders
            </button>
            <button
              onClick={logout}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" />
              Log out
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 flex min-h-0 overflow-hidden">
        <OutreachTab />
      </div>

      <Dialog open={sendersOpen} onOpenChange={setSendersOpen}>
        <DialogContent className="max-w-5xl w-[95vw] max-h-[90vh] overflow-hidden flex flex-col p-0">
          <DialogHeader className="px-6 pt-6 pb-3 border-b">
            <DialogTitle className="flex items-center gap-2 text-lg">
              <Server className="w-5 h-5" />
              Sender Accounts
            </DialogTitle>
            <DialogDescription>
              Manage SMTP sender accounts and groups. Add multiple accounts to rotate sends and
              raise your daily volume.
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto p-6">
            <SendersTab />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
