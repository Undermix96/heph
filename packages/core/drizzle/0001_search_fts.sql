-- Full-text search over projects, phases, tasks, diary entries and docs.
-- One FTS5 table, kept in sync by triggers. `kind` + `ref_id` point back to the source row.
-- kinds: project, phase, task, diary, internal_docs, repo_docs
CREATE VIRTUAL TABLE `search_fts` USING fts5(
	kind UNINDEXED,
	ref_id UNINDEXED,
	project_id UNINDEXED,
	title,
	body,
	tokenize = 'unicode61 remove_diacritics 2',
	prefix = '2 3'
);
--> statement-breakpoint
-- projects (name + description + status note) and their internal docs
CREATE TRIGGER `projects_fts_ai` AFTER INSERT ON `projects` BEGIN
	INSERT INTO search_fts(kind, ref_id, project_id, title, body)
	VALUES ('project', NEW.id, NEW.id, NEW.name, NEW.description || char(10) || NEW.status_note);
	INSERT INTO search_fts(kind, ref_id, project_id, title, body)
	SELECT 'internal_docs', NEW.id, NEW.id, NEW.name, NEW.internal_docs WHERE NEW.internal_docs <> '';
END;
--> statement-breakpoint
CREATE TRIGGER `projects_fts_au` AFTER UPDATE OF name, description, status_note, internal_docs ON `projects` BEGIN
	DELETE FROM search_fts WHERE kind IN ('project', 'internal_docs') AND ref_id = OLD.id;
	INSERT INTO search_fts(kind, ref_id, project_id, title, body)
	VALUES ('project', NEW.id, NEW.id, NEW.name, NEW.description || char(10) || NEW.status_note);
	INSERT INTO search_fts(kind, ref_id, project_id, title, body)
	SELECT 'internal_docs', NEW.id, NEW.id, NEW.name, NEW.internal_docs WHERE NEW.internal_docs <> '';
END;
--> statement-breakpoint
CREATE TRIGGER `projects_fts_ad` AFTER DELETE ON `projects` BEGIN
	DELETE FROM search_fts WHERE project_id = OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER `phases_fts_ai` AFTER INSERT ON `phases` BEGIN
	INSERT INTO search_fts(kind, ref_id, project_id, title, body)
	VALUES ('phase', NEW.id, NEW.project_id, NEW.title, NEW.description);
END;
--> statement-breakpoint
CREATE TRIGGER `phases_fts_au` AFTER UPDATE OF title, description ON `phases` BEGIN
	DELETE FROM search_fts WHERE kind = 'phase' AND ref_id = OLD.id;
	INSERT INTO search_fts(kind, ref_id, project_id, title, body)
	VALUES ('phase', NEW.id, NEW.project_id, NEW.title, NEW.description);
END;
--> statement-breakpoint
CREATE TRIGGER `phases_fts_ad` AFTER DELETE ON `phases` BEGIN
	DELETE FROM search_fts WHERE kind = 'phase' AND ref_id = OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER `tasks_fts_ai` AFTER INSERT ON `tasks` BEGIN
	INSERT INTO search_fts(kind, ref_id, project_id, title, body)
	VALUES ('task', NEW.id, NEW.project_id, NEW.title, NEW.notes);
END;
--> statement-breakpoint
CREATE TRIGGER `tasks_fts_au` AFTER UPDATE OF title, notes, project_id ON `tasks` BEGIN
	DELETE FROM search_fts WHERE kind = 'task' AND ref_id = OLD.id;
	INSERT INTO search_fts(kind, ref_id, project_id, title, body)
	VALUES ('task', NEW.id, NEW.project_id, NEW.title, NEW.notes);
END;
--> statement-breakpoint
CREATE TRIGGER `tasks_fts_ad` AFTER DELETE ON `tasks` BEGIN
	DELETE FROM search_fts WHERE kind = 'task' AND ref_id = OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER `diary_fts_ai` AFTER INSERT ON `diary_entries` WHEN NEW.body <> '' BEGIN
	INSERT INTO search_fts(kind, ref_id, project_id, title, body)
	VALUES ('diary', NEW.id, NEW.project_id, '', NEW.body);
END;
--> statement-breakpoint
CREATE TRIGGER `diary_fts_ad` AFTER DELETE ON `diary_entries` BEGIN
	DELETE FROM search_fts WHERE kind = 'diary' AND ref_id = OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER `repos_fts_ai` AFTER INSERT ON `project_repos` WHEN NEW.docs_content IS NOT NULL BEGIN
	INSERT INTO search_fts(kind, ref_id, project_id, title, body)
	VALUES ('repo_docs', NEW.id, NEW.project_id, NEW.full_name || '/' || NEW.docs_path, NEW.docs_content);
END;
--> statement-breakpoint
CREATE TRIGGER `repos_fts_au` AFTER UPDATE OF docs_content, docs_path, project_id ON `project_repos` BEGIN
	DELETE FROM search_fts WHERE kind = 'repo_docs' AND ref_id = OLD.id;
	INSERT INTO search_fts(kind, ref_id, project_id, title, body)
	SELECT 'repo_docs', NEW.id, NEW.project_id, NEW.full_name || '/' || NEW.docs_path, NEW.docs_content
	WHERE NEW.docs_content IS NOT NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `repos_fts_ad` AFTER DELETE ON `project_repos` BEGIN
	DELETE FROM search_fts WHERE kind = 'repo_docs' AND ref_id = OLD.id;
END;
