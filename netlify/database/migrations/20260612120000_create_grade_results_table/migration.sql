CREATE TABLE "grade_results" (
	"id" serial PRIMARY KEY,
	"result_key" text NOT NULL UNIQUE,
	"event_id" text NOT NULL,
	"game_pk" integer,
	"commence_time" timestamp,
	"player_id" integer,
	"player_name" text NOT NULL,
	"market" text NOT NULL,
	"side" text NOT NULL,
	"line" double precision,
	"grade" text NOT NULL,
	"best_odds" integer,
	"status" text NOT NULL DEFAULT 'pending',
	"actual_value" double precision,
	"graded_at" timestamp DEFAULT now(),
	"settled_at" timestamp
);
