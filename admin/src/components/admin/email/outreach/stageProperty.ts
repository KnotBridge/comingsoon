import { supabase } from "@/integrations/supabase/client";
import type { OutreachContact } from "./types";

// Drop a contact's listing straight into the current user's workspace. We reuse the
// exact path a recipient uses on their dynamic page: find-or-create the contact's
// (no-campaign) outreach_dynamic_pages row, then POST its token to re-claim-dynamic-page
// with the signed-in user's token. That edge function re-hosts the listing images and
// creates one project per room under a room_project, so it lands identically to a real
// claim — just triggered by us. Returns the created room_project id.

const FB = "https://akfggpfvpiozrwcvvyxi.supabase.co/functions/v1";

export function hasListingToStage(c: Partial<OutreachContact> | null | undefined): boolean {
  // Staging re-hosts the listing PHOTOS and makes one project per room, so photos are
  // what it actually needs — an address alone can't be staged.
  return !!(c && ((c.listing_image_urls as string[] | undefined)?.length ?? 0) > 0);
}

function listingSnapshot(c: OutreachContact) {
  return {
    email: c.email, street_address: c.street_address, city: c.city, state: c.property_state, zip: c.property_zip,
    bedrooms: c.property_bedrooms, bathrooms: c.property_bathrooms, square_feet: c.property_square_feet,
    year_built: c.property_year_built, property_type: c.property_type, listing_amount: c.listing_amount,
    days_on_market: c.days_on_market, agent_name: c.agent_name, listing_image_urls: c.listing_image_urls,
  };
}

export async function stageContactProperty(contact: OutreachContact): Promise<string> {
  let token: string | undefined;
  const { data: existing } = await supabase.from("outreach_dynamic_pages")
    .select("token").eq("contact_id", contact.id).is("campaign_id", null)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  token = (existing as { token?: string } | null)?.token;
  if (!token) {
    const { data: created, error } = await supabase.from("outreach_dynamic_pages")
      .insert({ contact_id: contact.id, recipient_email: contact.email, snapshot: listingSnapshot(contact) })
      .select("token").single();
    if (error || !created) throw error || new Error("Could not create the listing page");
    token = (created as { token: string }).token;
  }

  const { data: session } = await supabase.auth.getSession();
  const accessToken = session?.session?.access_token;
  const res = await fetch(`${FB}/re-claim-dynamic-page`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ token }),
  });
  const payload = await res.json();
  if (!res.ok) throw new Error(payload.error || "Could not stage the property");
  return payload.room_project_id as string;
}
