import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { OutreachSequence, OutreachSequenceStep, OutreachAudience } from "./types";
import { Plus, Trash2, GripVertical, ChevronDown, ChevronUp, Play, Pause } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface Props {
  audiences: OutreachAudience[];
}

export default function SequencesPage({ audiences }: Props) {
  const [sequences, setSequences] = useState<OutreachSequence[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSeq, setSelectedSeq] = useState<OutreachSequence | null>(null);
  const [steps, setSteps] = useState<OutreachSequenceStep[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newSeqName, setNewSeqName] = useState("");
  const [newSeqDesc, setNewSeqDesc] = useState("");
  const [showEnroll, setShowEnroll] = useState(false);
  const [enrollAudienceId, setEnrollAudienceId] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  const [enrollCounts, setEnrollCounts] = useState<Record<string, number>>({});

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from("outreach_sequences").select("*").order("created_at", { ascending: false });
    setSequences((data as OutreachSequence[]) || []);

    // Load enrollment counts
    const counts: Record<string, number> = {};
    for (const seq of (data as OutreachSequence[]) || []) {
      const { count } = await supabase.from("outreach_sequence_enrollments")
        .select("*", { count: "exact", head: true })
        .eq("sequence_id", seq.id)
        .eq("status", "active");
      counts[seq.id] = count || 0;
    }
    setEnrollCounts(counts);
    setLoading(false);
  }, []);

  const loadSteps = useCallback(async (seqId: string) => {
    const { data } = await supabase.from("outreach_sequence_steps")
      .select("*").eq("sequence_id", seqId).order("step_number");
    setSteps((data as OutreachSequenceStep[]) || []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const createSequence = async () => {
    if (!newSeqName.trim()) return;
    const { data, error } = await supabase.from("outreach_sequences").insert({
      name: newSeqName.trim(),
      description: newSeqDesc.trim() || null,
    }).select().single();
    if (error) { toast.error("Failed to create sequence"); return; }
    toast.success("Sequence created");
    setShowCreate(false);
    setNewSeqName(""); setNewSeqDesc("");
    load();
    setSelectedSeq(data as OutreachSequence);
    setSteps([]);
  };

  const deleteSequence = async (id: string) => {
    if (!confirm("Delete this sequence? All steps and enrollments will be removed.")) return;
    await supabase.from("outreach_sequences").delete().eq("id", id);
    if (selectedSeq?.id === id) { setSelectedSeq(null); setSteps([]); }
    load();
  };

  const toggleStatus = async (seq: OutreachSequence) => {
    const next = seq.status === "active" ? "paused" : "active";
    await supabase.from("outreach_sequences").update({ status: next }).eq("id", seq.id);
    setSequences(prev => prev.map(s => s.id === seq.id ? { ...s, status: next } : s));
    if (selectedSeq?.id === seq.id) setSelectedSeq(prev => prev ? { ...prev, status: next } : null);
  };

  const addStep = async () => {
    if (!selectedSeq) return;
    const stepNum = steps.length + 1;
    const { data, error } = await supabase.from("outreach_sequence_steps").insert({
      sequence_id: selectedSeq.id,
      step_number: stepNum,
      subject: `Follow-up ${stepNum}`,
      body_html: "",
      delay_days: stepNum === 1 ? 0 : 3,
      condition: stepNum === 1 ? "always" : "no_reply",
    }).select().single();
    if (error) { toast.error("Failed to add step"); return; }
    setSteps(prev => [...prev, data as OutreachSequenceStep]);
  };

  const updateStep = async (id: string, field: keyof OutreachSequenceStep, value: unknown) => {
    setSteps(prev => prev.map(s => s.id === id ? { ...s, [field]: value } : s));
    await supabase.from("outreach_sequence_steps").update({ [field]: value } as never).eq("id", id);
  };

  const deleteStep = async (id: string) => {
    await supabase.from("outreach_sequence_steps").delete().eq("id", id);
    setSteps(prev => prev.filter(s => s.id !== id));
  };

  const enrollAudience = async () => {
    if (!selectedSeq || !enrollAudienceId) return;
    setEnrolling(true);

    const { data: contacts } = await supabase.from("outreach_contacts")
      .select("id").eq("audience_id", enrollAudienceId)
      .not("status", "eq", "unsubscribed").not("status", "eq", "rejected");

    if (!contacts || contacts.length === 0) {
      toast.error("No eligible contacts in this audience"); setEnrolling(false); return;
    }

    const enrollments = contacts.map((c: { id: string }) => ({
      sequence_id: selectedSeq.id,
      contact_id: c.id,
      current_step: 1,
      status: "active" as const,
      next_send_at: new Date().toISOString(),
    }));

    // Insert, ignore duplicates via upsert
    const { error } = await supabase.from("outreach_sequence_enrollments")
      .upsert(enrollments, { onConflict: "sequence_id,contact_id", ignoreDuplicates: true });

    setEnrolling(false);
    if (error) { toast.error("Enrollment failed: " + error.message); return; }
    toast.success(`${contacts.length} contacts enrolled`);
    setShowEnroll(false);
    load();
  };

  return (
    <div className="flex gap-6 h-full">
      {/* Left: list */}
      <div className="w-72 flex-shrink-0 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-foreground">Sequences</h3>
          <Button size="sm" variant="outline" onClick={() => setShowCreate(true)} className="gap-1.5 text-xs h-8">
            <Plus className="w-3.5 h-3.5" /> New
          </Button>
        </div>

        {showCreate && (
          <div className="border border-border rounded-xl p-3 bg-card flex flex-col gap-2">
            <Input placeholder="Sequence name" value={newSeqName} onChange={e => setNewSeqName(e.target.value)} className="h-8 text-sm" />
            <Input placeholder="Description (optional)" value={newSeqDesc} onChange={e => setNewSeqDesc(e.target.value)} className="h-8 text-sm" />
            <div className="flex gap-2">
              <Button size="sm" onClick={createSequence} className="flex-1 h-7 text-xs">Create</Button>
              <Button size="sm" variant="ghost" onClick={() => setShowCreate(false)} className="h-7 text-xs">Cancel</Button>
            </div>
          </div>
        )}

        {loading && <p className="text-sm text-muted-foreground text-center py-4">Loading…</p>}
        {!loading && sequences.length === 0 && <p className="text-sm text-muted-foreground text-center py-4">No sequences yet</p>}
        {sequences.map(s => (
          <button key={s.id} onClick={() => { setSelectedSeq(s); loadSteps(s.id); setShowEnroll(false); }}
            className={cn("w-full flex items-start gap-3 px-3 py-2.5 rounded-lg text-left transition-colors group border", selectedSeq?.id === s.id ? "bg-primary/10 border-primary/20" : "border-transparent hover:bg-muted/60")}>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground truncate">{s.name}</p>
              <p className="text-xs text-muted-foreground">{enrollCounts[s.id] || 0} active · {s.status}</p>
            </div>
            <div className="flex gap-1 opacity-0 group-hover:opacity-100">
              <button onClick={e => { e.stopPropagation(); toggleStatus(s); }} className="p-1 text-muted-foreground hover:text-foreground">
                {s.status === "active" ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
              </button>
              <button onClick={e => { e.stopPropagation(); deleteSequence(s.id); }} className="p-1 text-destructive">
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          </button>
        ))}
      </div>

      {/* Right: step builder */}
      <div className="flex-1 min-w-0">
        {!selectedSeq ? (
          <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
            <p className="text-sm">Select a sequence to edit its steps</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-foreground">{selectedSeq.name}</h3>
                <p className="text-xs text-muted-foreground">{steps.length} steps · {enrollCounts[selectedSeq.id] || 0} enrolled</p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setShowEnroll(!showEnroll)} className="h-8 text-xs gap-1.5">
                  <Play className="w-3.5 h-3.5" /> Enroll audience
                </Button>
                <Button size="sm" onClick={addStep} className="h-8 text-xs gap-1.5">
                  <Plus className="w-3.5 h-3.5" /> Add step
                </Button>
              </div>
            </div>

            {showEnroll && (
              <div className="border border-border rounded-xl p-4 bg-muted/30 flex gap-3 items-end">
                <div className="flex-1">
                  <label className="text-xs text-muted-foreground mb-1 block">Enroll all contacts from audience</label>
                  <select value={enrollAudienceId} onChange={e => setEnrollAudienceId(e.target.value)} className="w-full h-8 text-sm border border-input rounded-md px-2 bg-background">
                    <option value="">Select audience…</option>
                    {audiences.map(a => <option key={a.id} value={a.id}>{a.name} ({a.contact_count})</option>)}
                  </select>
                </div>
                <Button size="sm" onClick={enrollAudience} disabled={enrolling || !enrollAudienceId} className="h-8 text-xs">
                  {enrolling ? "Enrolling…" : "Enroll"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowEnroll(false)} className="h-8 text-xs">Cancel</Button>
              </div>
            )}

            {steps.length === 0 && (
              <div className="text-center py-8 text-muted-foreground text-sm border border-dashed border-border rounded-xl">
                No steps yet — click "Add step" to start
              </div>
            )}

            {steps.map((step, idx) => (
              <div key={step.id} className="border border-border rounded-xl p-4 bg-card flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">{step.step_number}</span>
                    <span className="text-sm font-medium text-foreground">
                      {idx === 0 ? "First email (sent immediately)" : `After ${step.delay_days} day${step.delay_days !== 1 ? "s" : ""}`}
                    </span>
                  </div>
                  <button onClick={() => deleteStep(step.id)} className="text-destructive opacity-60 hover:opacity-100">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                {idx > 0 && (
                  <div className="flex gap-3">
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">Delay (days)</label>
                      <Input type="number" min="0" value={step.delay_days} onChange={e => updateStep(step.id, "delay_days", parseInt(e.target.value) || 0)} className="h-8 text-sm w-20" />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">Send if</label>
                      <select value={step.condition} onChange={e => updateStep(step.id, "condition", e.target.value)} className="h-8 text-sm border border-input rounded-md px-2 bg-background">
                        <option value="always">Always</option>
                        <option value="no_reply">No reply</option>
                        <option value="no_open">No open</option>
                        <option value="no_click">No click</option>
                      </select>
                    </div>
                  </div>
                )}

                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Subject</label>
                  <Input value={step.subject} onChange={e => updateStep(step.id, "subject", e.target.value)} className="text-sm" />
                </div>

                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Body (HTML or plain text)</label>
                  <Textarea value={step.body_html} onChange={e => updateStep(step.id, "body_html", e.target.value)} className="text-sm font-mono min-h-[120px] resize-y" />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
