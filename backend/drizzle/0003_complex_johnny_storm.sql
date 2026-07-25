CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"org_id" text,
	"action" text NOT NULL,
	"target_entity" text NOT NULL,
	"before_state" jsonb,
	"after_state" jsonb,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_validations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"db_instance_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"neon_branch_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "database_instances" ADD COLUMN "neon_project_id" text;--> statement-breakpoint
ALTER TABLE "backup_validations" ADD CONSTRAINT "backup_validations_db_instance_id_database_instances_id_fk" FOREIGN KEY ("db_instance_id") REFERENCES "public"."database_instances"("id") ON DELETE cascade ON UPDATE no action;