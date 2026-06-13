CREATE TABLE "odds" (
	"id" serial PRIMARY KEY,
	"event_id" text NOT NULL UNIQUE,
	"sport_key" text NOT NULL,
	"home_team" text NOT NULL,
	"away_team" text NOT NULL,
	"commence_time" timestamp,
	"odds_data" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
