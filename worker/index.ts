/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/status" || url.pathname === "/api/history" || url.pathname === "/api/settings") {
      const allowedStatuses = new Set(["idle", "busy", "critical", "waiting", "claimed"]);
      const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
      try {
        await env.DB.batch([
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS station_status (
            station_id TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'idle',
            requested_at INTEGER,
            claimed_at INTEGER,
            responder TEXT,
            updated_at INTEGER NOT NULL,
            revision INTEGER NOT NULL DEFAULT 0
          )`),
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS status_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            station_id TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at INTEGER NOT NULL
          )`),
          env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_status_events_station_created ON status_events(station_id, created_at)"),
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS activity_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            station_id TEXT NOT NULL,
            action TEXT NOT NULL,
            status TEXT NOT NULL,
            response_ms INTEGER,
            created_at INTEGER NOT NULL
          )`),
          env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_activity_events_station_created ON activity_events(station_id, created_at)"),
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS processed_mutations (
            mutation_id TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL
          )`),
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS station_settings (
            station_id TEXT PRIMARY KEY,
            busy_warning_minutes INTEGER NOT NULL DEFAULT 10,
            urgent_warning_minutes INTEGER NOT NULL DEFAULT 5,
            updated_at INTEGER NOT NULL
          )`),
        ]);

        const stationId = "main";
        const now = Date.now();

        if (url.pathname === "/api/settings") {
          if (request.method === "GET") {
            await env.DB.prepare(`INSERT OR IGNORE INTO station_settings
              (station_id, busy_warning_minutes, urgent_warning_minutes, updated_at)
              VALUES (?, 10, 5, ?)`).bind(stationId, now).run();
            const settings = await env.DB.prepare(`SELECT busy_warning_minutes AS busyWarningMinutes,
              urgent_warning_minutes AS urgentWarningMinutes, updated_at AS updatedAt
              FROM station_settings WHERE station_id = ?`).bind(stationId).first();
            return new Response(JSON.stringify(settings), { headers });
          }
          if (request.method === "PUT") {
            const body = await request.json() as { busyWarningMinutes?: number; urgentWarningMinutes?: number };
            const busy = Number(body.busyWarningMinutes);
            const urgent = Number(body.urgentWarningMinutes);
            if (!Number.isInteger(busy) || !Number.isInteger(urgent) || busy < 1 || busy > 60 || urgent < 1 || urgent > 60) {
              return new Response(JSON.stringify({ error: "invalid_settings" }), { status: 400, headers });
            }
            await env.DB.prepare(`INSERT INTO station_settings
              (station_id, busy_warning_minutes, urgent_warning_minutes, updated_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(station_id) DO UPDATE SET
                busy_warning_minutes = excluded.busy_warning_minutes,
                urgent_warning_minutes = excluded.urgent_warning_minutes,
                updated_at = excluded.updated_at`)
              .bind(stationId, busy, urgent, now).run();
            return new Response(JSON.stringify({ busyWarningMinutes: busy, urgentWarningMinutes: urgent, updatedAt: now }), { headers });
          }
          return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers });
        }

        if (url.pathname === "/api/history" && request.method === "GET") {
          const since = now - 24 * 60 * 60 * 1000;
          const events = await env.DB.prepare(`SELECT id, action, status,
            response_ms AS responseMs, created_at AS createdAt
            FROM activity_events WHERE station_id = ?
            ORDER BY created_at DESC LIMIT 40`).bind(stationId).all();
          const summary = await env.DB.prepare(`SELECT
            SUM(CASE WHEN action = 'status_busy' THEN 1 ELSE 0 END) AS busyCount,
            SUM(CASE WHEN action IN ('status_critical', 'status_waiting') THEN 1 ELSE 0 END) AS urgentCount,
            SUM(CASE WHEN action = 'acknowledged' THEN 1 ELSE 0 END) AS acknowledgedCount,
            CAST(AVG(CASE WHEN action IN ('acknowledged', 'responding') THEN response_ms END) AS INTEGER) AS averageResponseMs
            FROM activity_events WHERE station_id = ? AND created_at >= ?`)
            .bind(stationId, since).first();
          return new Response(JSON.stringify({ events: events.results, summary }), { headers });
        }

        if (request.method === "GET") {
          await env.DB.prepare(`INSERT OR IGNORE INTO station_status
            (station_id, status, updated_at, revision) VALUES (?, 'idle', ?, 0)`)
            .bind(stationId, now).run();
          const row = await env.DB.prepare(`SELECT status, requested_at AS requestedAt,
            claimed_at AS claimedAt, responder, updated_at AS updatedAt, revision
            FROM station_status WHERE station_id = ?`).bind(stationId).first();
          return new Response(JSON.stringify(row), { headers });
        }

        if (request.method === "PUT") {
          const body = await request.json() as {
            status?: string; requestedAt?: number | null; claimedAt?: number | null; responder?: string | null; mutationId?: string;
          };
          if (!body.status || !allowedStatuses.has(body.status)) {
            return new Response(JSON.stringify({ error: "invalid_status" }), { status: 400, headers });
          }
          if (body.mutationId) {
            const duplicate = await env.DB.prepare("SELECT mutation_id FROM processed_mutations WHERE mutation_id = ?")
              .bind(body.mutationId).first();
            if (duplicate) {
              const existing = await env.DB.prepare(`SELECT status, requested_at AS requestedAt,
                claimed_at AS claimedAt, responder, updated_at AS updatedAt, revision
                FROM station_status WHERE station_id = ?`).bind(stationId).first();
              return new Response(JSON.stringify(existing), { headers });
            }
          }
          const previous = await env.DB.prepare("SELECT status, responder FROM station_status WHERE station_id = ?")
            .bind(stationId).first<{ status?: string; responder?: string }>();
          const action = body.responder === "確認済み"
            ? "acknowledged"
            : body.responder === "対応中"
              ? "responding"
              : body.status === "idle" && previous?.status && previous.status !== "idle"
                ? "completed"
                : `status_${body.status}`;
          const responseMs = body.requestedAt ? Math.max(0, now - body.requestedAt) : null;
          await env.DB.batch([
            env.DB.prepare(`INSERT INTO station_status
              (station_id, status, requested_at, claimed_at, responder, updated_at, revision)
              VALUES (?, ?, ?, ?, ?, ?, 1)
              ON CONFLICT(station_id) DO UPDATE SET
                status = excluded.status,
                requested_at = excluded.requested_at,
                claimed_at = excluded.claimed_at,
                responder = excluded.responder,
                updated_at = excluded.updated_at,
                revision = station_status.revision + 1`)
              .bind(stationId, body.status, body.requestedAt ?? null, body.claimedAt ?? null, body.responder ?? null, now),
            env.DB.prepare("INSERT INTO status_events (station_id, status, created_at) VALUES (?, ?, ?)")
              .bind(stationId, body.status, now),
            env.DB.prepare("INSERT INTO activity_events (station_id, action, status, response_ms, created_at) VALUES (?, ?, ?, ?, ?)")
              .bind(stationId, action, body.status, responseMs, now),
            ...(body.mutationId ? [env.DB.prepare("INSERT INTO processed_mutations (mutation_id, created_at) VALUES (?, ?)")
              .bind(body.mutationId, now)] : []),
          ]);
          const row = await env.DB.prepare(`SELECT status, requested_at AS requestedAt,
            claimed_at AS claimedAt, responder, updated_at AS updatedAt, revision
            FROM station_status WHERE station_id = ?`).bind(stationId).first();
          return new Response(JSON.stringify(row), { headers });
        }

        return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers });
      } catch (error) {
        return new Response(JSON.stringify({ error: "database_error", detail: String(error) }), { status: 500, headers });
      }
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;

