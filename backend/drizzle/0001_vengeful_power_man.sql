CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"db_instance_id" uuid NOT NULL,
	"encrypted_connection" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secrets_db_instance_id_unique" UNIQUE("db_instance_id")
);
--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_db_instance_id_database_instances_id_fk" FOREIGN KEY ("db_instance_id") REFERENCES "public"."database_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_instances" DROP COLUMN "connection_secret_ref";