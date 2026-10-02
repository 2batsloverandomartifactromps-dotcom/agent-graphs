CREATE TABLE `aims` (
	`id` text PRIMARY KEY NOT NULL,
	`graph_id` text NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`kind` text NOT NULL,
	`terminating` integer NOT NULL,
	`guard` integer NOT NULL,
	`weight` real,
	`metric` text,
	`comparator` text,
	`target` real,
	`target_max` real,
	`unit` text,
	`source` text NOT NULL,
	`aggregation` text NOT NULL,
	`criteria` text,
	`evaluator` text NOT NULL,
	`evaluator_key` text,
	`implicit` integer NOT NULL,
	`sort_order` integer NOT NULL,
	`status` text NOT NULL,
	`current_value` real,
	`last_evaluation_id` text,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`graph_id`) REFERENCES `graphs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `aims_owner_key_uq` ON `aims` (`owner_type`,`owner_id`,`key`);--> statement-breakpoint
CREATE INDEX `aims_graph_idx` ON `aims` (`graph_id`);--> statement-breakpoint
CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`token_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_hash_unique` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`graph_id` text NOT NULL,
	`node_id` text NOT NULL,
	`number` integer NOT NULL,
	`activation` integer NOT NULL,
	`status` text NOT NULL,
	`counted` integer NOT NULL,
	`session_id` text,
	`executor` text NOT NULL,
	`dispatched_by` text,
	`lease_expires_at` integer,
	`last_heartbeat_at` integer,
	`progress` integer,
	`current_step` text,
	`checkpoint` text,
	`checklist_state` text NOT NULL,
	`feedback_in` text,
	`summary` text,
	`outcome_reason` text,
	`usage` text,
	`manual` integer NOT NULL,
	`briefing_hash` text,
	`last_progress_event_at` integer,
	`timeout_escalated` integer,
	`started_at` integer NOT NULL,
	`submitted_at` integer,
	`passed_at` integer,
	`ended_at` integer,
	FOREIGN KEY (`graph_id`) REFERENCES `graphs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_node_number_uq` ON `attempts` (`node_id`,`number`);--> statement-breakpoint
CREATE INDEX `attempts_graph_status_idx` ON `attempts` (`graph_id`,`status`);--> statement-breakpoint
CREATE INDEX `attempts_lease_idx` ON `attempts` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `attempts_session_idx` ON `attempts` (`session_id`);--> statement-breakpoint
CREATE TABLE `directive_deliveries` (
	`directive_id` text NOT NULL,
	`recipient` text NOT NULL,
	`graph_id` text NOT NULL,
	`delivered_at` integer NOT NULL,
	`delivered_via` text NOT NULL,
	`acked_at` integer,
	`acked_by` text,
	`ack_note` text,
	PRIMARY KEY(`directive_id`, `recipient`)
);
--> statement-breakpoint
CREATE INDEX `deliveries_graph_idx` ON `directive_deliveries` (`graph_id`);--> statement-breakpoint
CREATE TABLE `directives` (
	`id` text PRIMARY KEY NOT NULL,
	`graph_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`data` text,
	`requires_ack` integer NOT NULL,
	`status` text NOT NULL,
	`request_id` text,
	`supersedes` text,
	`expires_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`graph_id`) REFERENCES `graphs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `directives_target_idx` ON `directives` (`graph_id`,`target_type`,`target_id`,`status`);--> statement-breakpoint
CREATE TABLE `edges` (
	`id` text PRIMARY KEY NOT NULL,
	`graph_id` text NOT NULL,
	`from_node_id` text NOT NULL,
	`to_node_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text,
	`relation` text,
	`condition` text,
	`guidance` text,
	`pitfalls` text,
	`attr_provenance` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`graph_id`) REFERENCES `graphs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `edges_uq` ON `edges` (`graph_id`,`from_node_id`,`to_node_id`,`kind`);--> statement-breakpoint
CREATE INDEX `edges_from_idx` ON `edges` (`from_node_id`);--> statement-breakpoint
CREATE INDEX `edges_to_idx` ON `edges` (`to_node_id`);--> statement-breakpoint
CREATE TABLE `evaluations` (
	`id` text PRIMARY KEY NOT NULL,
	`graph_id` text NOT NULL,
	`aim_id` text NOT NULL,
	`attempt_id` text,
	`activation` integer NOT NULL,
	`verdict` text NOT NULL,
	`value` real,
	`score` real,
	`rationale` text,
	`evidence` text NOT NULL,
	`evaluator_kind` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`graph_id`) REFERENCES `graphs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `evaluations_aim_idx` ON `evaluations` (`aim_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `evaluations_attempt_idx` ON `evaluations` (`attempt_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`graph_id` text,
	`type` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`actor` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_id_unique` ON `events` (`id`);--> statement-breakpoint
CREATE INDEX `events_graph_idx` ON `events` (`graph_id`,`seq`);--> statement-breakpoint
CREATE INDEX `events_entity_idx` ON `events` (`entity_type`,`entity_id`,`seq`);--> statement-breakpoint
CREATE INDEX `events_type_idx` ON `events` (`type`,`seq`);--> statement-breakpoint
CREATE TABLE `graphs` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text,
	`title` text NOT NULL,
	`description` text,
	`status` text NOT NULL,
	`pending_approval` integer DEFAULT false NOT NULL,
	`tags` text NOT NULL,
	`repository` text,
	`context` text,
	`constraints` text NOT NULL,
	`policy` text NOT NULL,
	`defaults` text NOT NULL,
	`evolution` text NOT NULL,
	`metadata` text NOT NULL,
	`source_spec` text,
	`revision` integer NOT NULL,
	`version` integer NOT NULL,
	`stalled` integer DEFAULT false NOT NULL,
	`accepted_with_deviation` integer DEFAULT false NOT NULL,
	`chain_head` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`archived_at` integer,
	`last_activity_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `graphs_slug_unique` ON `graphs` (`slug`);--> statement-breakpoint
CREATE INDEX `graphs_status_idx` ON `graphs` (`status`,`archived_at`);--> statement-breakpoint
CREATE INDEX `graphs_activity_idx` ON `graphs` (`last_activity_at`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`token_id` text NOT NULL,
	`key` text NOT NULL,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`request_hash` text NOT NULL,
	`status_code` integer NOT NULL,
	`response_body` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`token_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `lesson_applications` (
	`lesson_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`outcome` text NOT NULL,
	`tag` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`lesson_id`, `attempt_id`)
);
--> statement-breakpoint
CREATE TABLE `lesson_duties` (
	`id` text PRIMARY KEY NOT NULL,
	`graph_id` text NOT NULL,
	`node_id` text NOT NULL,
	`passed_attempt_id` text NOT NULL,
	`failed_attempt_ids` text NOT NULL,
	`status` text NOT NULL,
	`lesson_id` text,
	`assignee` text NOT NULL,
	`created_at` integer NOT NULL,
	`closed_at` integer,
	FOREIGN KEY (`graph_id`) REFERENCES `graphs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `lesson_duties_graph_idx` ON `lesson_duties` (`graph_id`,`status`);--> statement-breakpoint
CREATE TABLE `lessons` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`kind` text NOT NULL,
	`condition` text,
	`content` text NOT NULL,
	`evidence` text NOT NULL,
	`source` text NOT NULL,
	`counters` text NOT NULL,
	`status` text NOT NULL,
	`version` integer NOT NULL,
	`supersedes` text,
	`author` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `lessons_status_idx` ON `lessons` (`status`);--> statement-breakpoint
CREATE TABLE `loops` (
	`id` text PRIMARY KEY NOT NULL,
	`graph_id` text NOT NULL,
	`key` text NOT NULL,
	`title` text,
	`from_node_id` text NOT NULL,
	`to_node_id` text NOT NULL,
	`body` text NOT NULL,
	`max_iterations` integer NOT NULL,
	`granted_iterations` integer NOT NULL,
	`iteration` integer NOT NULL,
	`on_exhausted` text NOT NULL,
	`feedback_instructions` text,
	`status` text NOT NULL,
	`last_feedback` text,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`graph_id`) REFERENCES `graphs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loops_graph_key_uq` ON `loops` (`graph_id`,`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `loops_trigger_uq` ON `loops` (`from_node_id`);--> statement-breakpoint
CREATE TABLE `metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`graph_id` text NOT NULL,
	`node_id` text,
	`attempt_id` text,
	`name` text NOT NULL,
	`value` real NOT NULL,
	`unit` text,
	`actor` text NOT NULL,
	`note_id` text,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`graph_id`) REFERENCES `graphs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `metrics_graph_name_idx` ON `metrics` (`graph_id`,`name`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `metrics_attempt_idx` ON `metrics` (`attempt_id`,`name`);--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`graph_id` text NOT NULL,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`aim` text,
	`purpose` text,
	`prompt` text,
	`context` text,
	`deliverables` text NOT NULL,
	`checklist` text NOT NULL,
	`aim_mode` text NOT NULL,
	`priority` text NOT NULL,
	`tags` text NOT NULL,
	`executor` text NOT NULL,
	`gate` text,
	`max_attempts` integer NOT NULL,
	`granted_attempts` integer NOT NULL,
	`on_exhausted` text NOT NULL,
	`lease_ttl_sec` integer NOT NULL,
	`timeout_sec` integer,
	`parent_id` text,
	`position` text,
	`metadata` text NOT NULL,
	`status` text NOT NULL,
	`status_reason` text,
	`activation` integer NOT NULL,
	`counted_attempts` integer NOT NULL,
	`attempts_total` integer NOT NULL,
	`current_attempt_id` text,
	`accepted_with_deviation` integer NOT NULL,
	`manual` integer NOT NULL,
	`feedback` text,
	`deferred_failure` text,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ready_at` integer,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`graph_id`) REFERENCES `graphs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nodes_graph_key_uq` ON `nodes` (`graph_id`,`key`);--> statement-breakpoint
CREATE INDEX `nodes_graph_status_idx` ON `nodes` (`graph_id`,`status`);--> statement-breakpoint
CREATE INDEX `nodes_graph_priority_idx` ON `nodes` (`graph_id`,`priority`);--> statement-breakpoint
CREATE TABLE `notes` (
	`id` text PRIMARY KEY NOT NULL,
	`graph_id` text NOT NULL,
	`node_id` text,
	`attempt_id` text,
	`orchestrator_id` text,
	`reply_to` text,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`severity` text,
	`evidence` text NOT NULL,
	`metrics` text,
	`author` text NOT NULL,
	`relayed_by` text,
	`usage` text,
	`pinned` integer NOT NULL,
	`retracted_at` integer,
	`retracted_reason` text,
	`retracted_by` text,
	`resolved_at` integer,
	`resolved_by` text,
	`resolution_note_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`graph_id`) REFERENCES `graphs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notes_graph_idx` ON `notes` (`graph_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notes_node_idx` ON `notes` (`node_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notes_type_idx` ON `notes` (`graph_id`,`type`);--> statement-breakpoint
CREATE TABLE `orchestrators` (
	`id` text PRIMARY KEY NOT NULL,
	`graph_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`aim` text,
	`purpose` text,
	`prompt` text,
	`scope` text NOT NULL,
	`capabilities` text NOT NULL,
	`triggers` text NOT NULL,
	`executor` text NOT NULL,
	`metadata` text NOT NULL,
	`status` text NOT NULL,
	`session_id` text,
	`lease_expires_at` integer,
	`last_heartbeat_at` integer,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`graph_id`) REFERENCES `graphs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orchestrators_graph_key_uq` ON `orchestrators` (`graph_id`,`key`);--> statement-breakpoint
CREATE TABLE `requests` (
	`id` text PRIMARY KEY NOT NULL,
	`graph_id` text NOT NULL,
	`node_id` text,
	`attempt_id` text,
	`aim_id` text,
	`loop_id` text,
	`kind` text NOT NULL,
	`subject` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`options` text NOT NULL,
	`assignee` text NOT NULL,
	`assignee_key` text,
	`blocking` integer NOT NULL,
	`status` text NOT NULL,
	`created_by` text NOT NULL,
	`resolution` text,
	`resolved_by` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	`expires_at` integer,
	FOREIGN KEY (`graph_id`) REFERENCES `graphs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `requests_status_idx` ON `requests` (`status`,`graph_id`);--> statement-breakpoint
CREATE INDEX `requests_node_idx` ON `requests` (`node_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text,
	`role` text,
	`provider` text,
	`model` text,
	`thinking` text,
	`thinking_budget` integer,
	`mechanism` text,
	`version` text,
	`client_session_id` text,
	`parent_session_id` text,
	`token_id` text,
	`skills` text NOT NULL,
	`meta` text NOT NULL,
	`status` text NOT NULL,
	`usage` text,
	`started_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`ended_at` integer
);
--> statement-breakpoint
CREATE INDEX `sessions_client_idx` ON `sessions` (`client_session_id`);--> statement-breakpoint
CREATE INDEX `sessions_status_idx` ON `sessions` (`status`,`last_seen_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
