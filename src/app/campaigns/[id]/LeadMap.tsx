"use client";

import "leaflet/dist/leaflet.css";
import type * as Leaflet from "leaflet";
import { useEffect, useRef, useState } from "react";
import type { WebsiteStatus } from "@/lib/detect";
import { WEBSITE_STATUS_LABEL } from "@/lib/display";

export interface MapLead {
  id: string;
  name: string;
  score: number;
  latitude: number | null;
  longitude: number | null;
  websiteStatus: WebsiteStatus;
}

// Status colours as dots: red has no site, amber needs work, grey unknown, green fine.
const DOT: Record<WebsiteStatus, string> = {
  NONE_FOUND: "#dc2626",
  NEEDS_WORK: "#d97706",
  NEEDS_CHECK: "#71717a",
  GOOD: "#059669",
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

type Placed = MapLead & { latitude: number; longitude: number };

/**
 * The campaign's leads on a map, one dot per lead with coordinates, coloured
 * by site status and sized by score. Leaflet touches `window`, so it is loaded
 * in the browser only. Tiles come from OpenStreetMap, credited as its usage
 * policy requires.
 *
 * The map is created once. A reload of the campaign (every 2s during a scan)
 * only redraws the dots, and the view is re-fitted only when the set of leads
 * shown changes, so the user's pan, zoom and open popup survive.
 */
export default function LeadMap({ leads }: { leads: MapLead[] }) {
  const container = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<{ L: typeof Leaflet; map: Leaflet.Map; dots: Leaflet.LayerGroup } | null>(null);
  const fittedTo = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let created: Leaflet.Map | undefined;
    import("leaflet").then((L) => {
      if (cancelled || !container.current) return;
      created = L.map(container.current, { scrollWheelZoom: false });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(created);
      setMap({ L, map: created, dots: L.layerGroup().addTo(created) });
    });
    return () => {
      cancelled = true;
      created?.remove();
    };
  }, []);

  useEffect(() => {
    if (!map) return;
    const { L, dots } = map;
    const placed = leads.filter((l): l is Placed => l.latitude !== null && l.longitude !== null);

    dots.clearLayers();
    for (const lead of placed) {
      // Names come from OSM, which anyone can edit, so they are escaped before reaching the popup's HTML.
      L.circleMarker([lead.latitude, lead.longitude], {
        radius: 5 + Math.min(lead.score, 100) / 15,
        color: DOT[lead.websiteStatus],
        fillColor: DOT[lead.websiteStatus],
        fillOpacity: 0.7,
        weight: 1,
      })
        .bindPopup(
          `<a href="/leads/${encodeURIComponent(lead.id)}"><strong>${escapeHtml(lead.name)}</strong></a><br>` +
            `Score ${lead.score.toFixed(1)} · ${escapeHtml(WEBSITE_STATUS_LABEL[lead.websiteStatus])}`
        )
        .addTo(dots);
    }

    const shown = placed.map((l) => l.id).sort().join(",");
    if (shown === fittedTo.current) return;
    fittedTo.current = shown;
    if (placed.length) {
      map.map.fitBounds(L.latLngBounds(placed.map((l) => [l.latitude, l.longitude] as [number, number])), {
        padding: [24, 24],
        maxZoom: 16,
      });
    } else {
      map.map.setView([41.33, 19.82], 12);
    }
  }, [map, leads]);

  const missing = leads.filter((l) => l.latitude === null || l.longitude === null).length;
  return (
    <div>
      <div ref={container} className="h-96 w-full overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800" />
      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
        {(Object.keys(DOT) as WebsiteStatus[]).map((s) => (
          <span key={s} className="mr-3 whitespace-nowrap">
            <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: DOT[s] }} />
            {WEBSITE_STATUS_LABEL[s]}
          </span>
        ))}
        Bigger dots score higher.{missing > 0 && ` ${missing} lead${missing === 1 ? " has" : "s have"} no location.`}
      </p>
    </div>
  );
}
