-- Rates: a creator's picture (a profile photo or a brand's logo), fetched once when they're added and kept here so the
-- site never depends on a social platform's image links, which expire or get blocked.
ALTER TABLE "rates"."creators" ADD COLUMN "avatar" bytea;--> statement-breakpoint
ALTER TABLE "rates"."creators" ADD COLUMN "avatar_mime" text;
