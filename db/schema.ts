import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const stationStatus = sqliteTable("station_status", {
  stationId: text("station_id").primaryKey(),
  status: text("status").notNull().default("idle"),
  requestedAt: integer("requested_at"),
  claimedAt: integer("claimed_at"),
  responder: text("responder"),
  updatedAt: integer("updated_at").notNull(),
  revision: integer("revision").notNull().default(0),
});

export const statusEvents = sqliteTable("status_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  stationId: text("station_id").notNull(),
  status: text("status").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const activityEvents = sqliteTable("activity_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  stationId: text("station_id").notNull(),
  action: text("action").notNull(),
  status: text("status").notNull(),
  responseMs: integer("response_ms"),
  createdAt: integer("created_at").notNull(),
});

export const processedMutations = sqliteTable("processed_mutations", {
  mutationId: text("mutation_id").primaryKey(),
  createdAt: integer("created_at").notNull(),
});

export const stationSettings = sqliteTable("station_settings", {
  stationId: text("station_id").primaryKey(),
  busyWarningMinutes: integer("busy_warning_minutes").notNull().default(10),
  urgentWarningMinutes: integer("urgent_warning_minutes").notNull().default(5),
  updatedAt: integer("updated_at").notNull(),
});

