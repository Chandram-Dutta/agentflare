import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";
import type { AgentId } from "@/lib/workspace";

export const project = sqliteTable(
  "project",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    repository: text("repository").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("project_owner_idx").on(table.ownerId)],
);

export const thread = sqliteTable(
  "thread",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    agent: text("agent").$type<AgentId>().notNull(),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("thread_project_idx").on(table.projectId)],
);
