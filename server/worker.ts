import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, desc } from "drizzle-orm";
import { z } from "zod";
import * as schema from "../shared/schema";
import {
  teams, players, matches, matchEvents,
  insertTeamSchema, insertPlayerSchema, insertMatchSchema, insertMatchEventSchema,
} from "../shared/schema";

interface Env {
  DATABASE_URL: string;
  ASSETS: Fetcher;
}

const { Pool } = pg;

let pool: pg.Pool | null = null;

function getDb(env: Env) {
  if (!pool) {
    pool = new Pool({ connectionString: env.DATABASE_URL, max: 1 });
  }
  return drizzle(pool, { schema });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function matchPath(pathname: string, pattern: string): Record<string, string> | null {
  const patternParts = pattern.split("/");
  const urlParts = pathname.split("/");
  if (patternParts.length !== urlParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = urlParts[i];
    } else if (patternParts[i] !== urlParts[i]) {
      return null;
    }
  }
  return params;
}

async function handleApi(request: Request, url: URL, env: Env): Promise<Response> {
  const db = getDb(env);
  const method = request.method.toUpperCase();
  const path = url.pathname;

  let body: unknown = null;
  if (["POST", "PATCH", "PUT"].includes(method)) {
    try {
      body = await request.json();
    } catch {
      return json({ message: "Invalid JSON body" }, 400);
    }
  }

  try {
    // GET /api/teams
    if (method === "GET" && matchPath(path, "/api/teams") !== null) {
      return json(await db.select().from(teams));
    }

    // POST /api/teams
    if (method === "POST" && matchPath(path, "/api/teams") !== null) {
      try {
        const input = insertTeamSchema.parse(body);
        const [team] = await db.insert(teams).values(input).returning();
        return json(team, 201);
      } catch (err) {
        if (err instanceof z.ZodError) {
          return json({ message: err.errors[0].message, field: err.errors[0].path.join(".") }, 400);
        }
        throw err;
      }
    }

    // GET /api/teams/:id
    {
      const params = matchPath(path, "/api/teams/:id");
      if (method === "GET" && params) {
        const [team] = await db.select().from(teams).where(eq(teams.id, Number(params.id)));
        if (!team) return json({ message: "Team not found" }, 404);
        return json(team);
      }
    }

    // GET /api/players
    if (method === "GET" && matchPath(path, "/api/players") !== null) {
      const teamIdStr = url.searchParams.get("teamId");
      const result = teamIdStr
        ? await db.select().from(players).where(eq(players.teamId, Number(teamIdStr)))
        : await db.select().from(players);
      return json(result);
    }

    // POST /api/players
    if (method === "POST" && matchPath(path, "/api/players") !== null) {
      try {
        const input = insertPlayerSchema.parse(body);
        const [player] = await db.insert(players).values(input).returning();
        return json(player, 201);
      } catch (err) {
        if (err instanceof z.ZodError) {
          return json({ message: err.errors[0].message, field: err.errors[0].path.join(".") }, 400);
        }
        throw err;
      }
    }

    // DELETE /api/players/:id
    {
      const params = matchPath(path, "/api/players/:id");
      if (method === "DELETE" && params) {
        await db.delete(players).where(eq(players.id, Number(params.id)));
        return new Response(null, { status: 204 });
      }
    }

    // GET /api/matches
    if (method === "GET" && matchPath(path, "/api/matches") !== null) {
      const result = await db.query.matches.findMany({
        with: { homeTeam: true, awayTeam: true },
        orderBy: desc(matches.date),
      });
      return json(result);
    }

    // POST /api/matches
    if (method === "POST" && matchPath(path, "/api/matches") !== null) {
      try {
        const rawBody = body as Record<string, unknown>;
        const input = insertMatchSchema.parse({ ...rawBody, date: new Date(rawBody.date as string) });
        const [match] = await db.insert(matches).values(input).returning();
        return json(match, 201);
      } catch (err) {
        if (err instanceof z.ZodError) {
          return json({ message: err.errors[0].message, field: err.errors[0].path.join(".") }, 400);
        }
        throw err;
      }
    }

    // PATCH /api/matches/:id/status
    {
      const params = matchPath(path, "/api/matches/:id/status");
      if (method === "PATCH" && params) {
        try {
          const input = z.object({ status: z.enum(["scheduled", "in_progress", "finished"]) }).parse(body);
          const [match] = await db.update(matches).set({ status: input.status }).where(eq(matches.id, Number(params.id))).returning();
          if (!match) return json({ message: "Match not found" }, 404);
          return json(match);
        } catch (err) {
          if (err instanceof z.ZodError) {
            return json({ message: err.errors[0].message, field: err.errors[0].path.join(".") }, 400);
          }
          throw err;
        }
      }
    }

    // GET /api/matches/:id/pdf — not supported in Worker
    {
      const params = matchPath(path, "/api/matches/:id/pdf");
      if (method === "GET" && params) {
        return json({ message: "PDF generation is not available on this deployment" }, 501);
      }
    }

    // GET /api/matches/:id
    {
      const params = matchPath(path, "/api/matches/:id");
      if (method === "GET" && params) {
        const match = await db.query.matches.findFirst({
          where: eq(matches.id, Number(params.id)),
          with: { homeTeam: true, awayTeam: true },
        });
        if (!match) return json({ message: "Match not found" }, 404);
        const events = await db
          .select()
          .from(matchEvents)
          .where(eq(matchEvents.matchId, match.id))
          .orderBy(desc(matchEvents.time));
        return json({ ...match, events });
      }
    }

    // POST /api/match-events
    if (method === "POST" && matchPath(path, "/api/match-events") !== null) {
      try {
        const input = insertMatchEventSchema.parse(body);
        const [event] = await db.insert(matchEvents).values(input).returning();

        if (input.type === "goal") {
          const match = await db.query.matches.findFirst({ where: eq(matches.id, input.matchId) });
          if (match) {
            if (match.homeTeamId === input.teamId) {
              await db.update(matches).set({ homeScore: (match.homeScore ?? 0) + 1 }).where(eq(matches.id, match.id));
            } else if (match.awayTeamId === input.teamId) {
              await db.update(matches).set({ awayScore: (match.awayScore ?? 0) + 1 }).where(eq(matches.id, match.id));
            }
          }
        }

        return json(event, 201);
      } catch (err) {
        if (err instanceof z.ZodError) {
          return json({ message: err.errors[0].message, field: err.errors[0].path.join(".") }, 400);
        }
        throw err;
      }
    }

    // DELETE /api/match-events/:id
    {
      const params = matchPath(path, "/api/match-events/:id");
      if (method === "DELETE" && params) {
        await db.delete(matchEvents).where(eq(matchEvents.id, Number(params.id)));
        return new Response(null, { status: 204 });
      }
    }

    return json({ message: "Not found" }, 404);
  } catch (err) {
    console.error("Worker error:", err);
    return json({ message: "Internal Server Error" }, 500);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, url, env);
    }

    return env.ASSETS.fetch(request);
  },
};
