-- Rates by Latars (rates.latars.xyz): its own accounts, creators, rates and uploaded rate cards in a `rates` schema,
-- separate from Event Connect and AdsSim. Sign-up needs no verification; the admin can hide or delete anything.
CREATE SCHEMA IF NOT EXISTS "rates";--> statement-breakpoint
CREATE TABLE "rates"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL UNIQUE,
	"name" text,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "rates"."sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "rates"."users"("id") ON DELETE cascade,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "rates_sessions_user_idx" ON "rates"."sessions" ("user_id");--> statement-breakpoint
CREATE TABLE "rates"."creators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL UNIQUE,
	"link_key" text UNIQUE,
	"name" text NOT NULL,
	"type" text DEFAULT 'creator' NOT NULL,
	"platform" text DEFAULT 'website' NOT NULL,
	"niche" text DEFAULT 'general' NOT NULL,
	"country" text DEFAULT 'NG' NOT NULL,
	"website" text,
	"handle" text,
	"followers" integer,
	"bio" text,
	"hidden" boolean DEFAULT false NOT NULL,
	"added_by" uuid REFERENCES "rates"."users"("id") ON DELETE set null,
	"added_by_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rates_creators_type_check" CHECK ("type" IN ('creator','media'))
);--> statement-breakpoint
CREATE INDEX "rates_creators_recent_idx" ON "rates"."creators" ("created_at");--> statement-breakpoint
CREATE TABLE "rates"."rate_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"creator_id" uuid NOT NULL REFERENCES "rates"."creators"("id") ON DELETE cascade,
	"deliverable" text NOT NULL,
	"platform" text NOT NULL,
	"price_min" integer NOT NULL,
	"price_max" integer NOT NULL,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"added_by" uuid REFERENCES "rates"."users"("id") ON DELETE set null,
	"added_by_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rates_items_currency_check" CHECK ("currency" IN ('USD','NGN','ZAR')),
	CONSTRAINT "rates_items_price_check" CHECK ("price_min" >= 0 AND "price_max" >= "price_min")
);--> statement-breakpoint
CREATE INDEX "rates_items_creator_idx" ON "rates"."rate_items" ("creator_id");--> statement-breakpoint
CREATE TABLE "rates"."files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_id" uuid NOT NULL REFERENCES "rates"."creators"("id") ON DELETE cascade,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"data" bytea NOT NULL,
	"added_by" uuid REFERENCES "rates"."users"("id") ON DELETE set null,
	"added_by_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "rates_files_creator_idx" ON "rates"."files" ("creator_id");
