import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
export function openStorage(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') chmodSync(dbPath, 0o600);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
  db.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,role TEXT NOT NULL,salt TEXT NOT NULL,hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY,jira_key TEXT UNIQUE NOT NULL,title TEXT NOT NULL,owner_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,progress INTEGER DEFAULT 0,last_summary TEXT DEFAULT '',updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS progress_events (id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),actor_id TEXT NOT NULL REFERENCES users(id),tool TEXT NOT NULL,device_id TEXT NOT NULL,progress INTEGER NOT NULL,summary TEXT NOT NULL,branch TEXT,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),stage TEXT NOT NULL,status TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS plugins (id TEXT PRIMARY KEY,manifest TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,action TEXT NOT NULL,target_id TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);`);
  const add = (table, name, spec) => { if (!db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${spec}`); };
  db.exec('BEGIN IMMEDIATE');
  try {
    const migrate = !db.prepare('SELECT version FROM schema_migrations WHERE version=1').get();
    add('tasks', 'project_id', "TEXT NOT NULL DEFAULT 'default'");
    add('tasks', 'parent_id', 'TEXT'); add('tasks', 'task_type', "TEXT NOT NULL DEFAULT 'TASK'"); add('tasks', 'assignee_id', 'TEXT'); add('tasks', 'status', "TEXT NOT NULL DEFAULT 'OPEN'"); add('tasks', 'version', 'INTEGER NOT NULL DEFAULT 1'); add('tasks', 'context_version', 'INTEGER NOT NULL DEFAULT 1');
    add('tasks', 'jira_verified', 'INTEGER NOT NULL DEFAULT 0'); add('tasks', 'external_ref', 'TEXT');
    add('jobs', 'project_id', "TEXT NOT NULL DEFAULT 'default'"); add('jobs', 'execution_mode', "TEXT NOT NULL DEFAULT 'CLOUD_AI'"); add('jobs', 'input_hash', "TEXT NOT NULL DEFAULT ''"); add('jobs', 'snapshot', "TEXT NOT NULL DEFAULT '{}'");
    add('plugins', 'project_id', "TEXT NOT NULL DEFAULT 'default'"); add('audit', 'project_id', 'TEXT');
    db.exec(`CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY,key TEXT NOT NULL UNIQUE,name TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_members (project_id TEXT NOT NULL REFERENCES projects(id),user_id TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL,PRIMARY KEY(project_id,user_id));
      CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),project_id TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL,logical_key TEXT NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,source_url TEXT,revision INTEGER NOT NULL,sha256 TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,UNIQUE(task_id,kind,logical_key,revision));
      CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY,job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),summary TEXT NOT NULL,source TEXT NOT NULL,tool TEXT,evidence TEXT,actor_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS findings (id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id),severity TEXT NOT NULL,title TEXT NOT NULL,detail TEXT NOT NULL,location TEXT);
      CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY,job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),decision TEXT NOT NULL,reason TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS waivers (id TEXT PRIMARY KEY,finding_id TEXT NOT NULL UNIQUE REFERENCES findings(id),reason TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (task_id TEXT NOT NULL REFERENCES tasks(id),device_id TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES users(id),tool TEXT NOT NULL,status TEXT NOT NULL,last_seen TEXT NOT NULL,PRIMARY KEY(task_id,device_id,actor_id));
      CREATE INDEX IF NOT EXISTS task_project_idx ON tasks(project_id);
      CREATE INDEX IF NOT EXISTS task_parent_idx ON tasks(parent_id);
      CREATE INDEX IF NOT EXISTS asset_task_idx ON assets(task_id);
      CREATE INDEX IF NOT EXISTS asset_project_created_idx ON assets(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS job_task_idx ON jobs(task_id);
      CREATE INDEX IF NOT EXISTS job_project_idx ON jobs(project_id);
      CREATE INDEX IF NOT EXISTS job_task_stage_idx ON jobs(task_id, stage);
      CREATE INDEX IF NOT EXISTS finding_job_idx ON findings(job_id);
      CREATE INDEX IF NOT EXISTS progress_task_idx ON progress_events(task_id);
      CREATE INDEX IF NOT EXISTS audit_project_idx ON audit(project_id);`);
    db.exec(`CREATE TABLE IF NOT EXISTS connector_configs (id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),provider TEXT NOT NULL,base_url TEXT NOT NULL,auth_mode TEXT NOT NULL,credential TEXT,organization_id TEXT NOT NULL DEFAULT '',status TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL,last_checked_at TEXT,last_error TEXT,UNIQUE(project_id,provider));
      CREATE TABLE IF NOT EXISTS external_imports (id TEXT PRIMARY KEY,connector_id TEXT NOT NULL REFERENCES connector_configs(id),resource TEXT NOT NULL,external_id TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id),kind TEXT NOT NULL,remote_version TEXT NOT NULL,content_hash TEXT NOT NULL,local_id TEXT NOT NULL REFERENCES assets(id),created_at TEXT NOT NULL,UNIQUE(connector_id,resource,external_id,task_id,kind,remote_version,content_hash));`);
    db.exec(`CREATE TABLE IF NOT EXISTS jira_project_bindings (project_id TEXT PRIMARY KEY REFERENCES projects(id),source_url TEXT NOT NULL,remote_id TEXT NOT NULL,remote_key TEXT NOT NULL,remote_name TEXT NOT NULL,project_type_key TEXT NOT NULL,category TEXT,synced_at TEXT NOT NULL,UNIQUE(source_url,remote_id));`);
    db.exec(`CREATE TABLE IF NOT EXISTS local_authorizations (device_hash TEXT PRIMARY KEY,user_hash TEXT UNIQUE NOT NULL,device_name TEXT NOT NULL,tool TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'PENDING',user_id TEXT REFERENCES users(id),project_ids TEXT NOT NULL DEFAULT '[]',last_poll_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS local_device_sessions (id TEXT PRIMARY KEY,token_hash TEXT UNIQUE NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),device_name TEXT NOT NULL,tool TEXT NOT NULL,project_ids TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at TEXT NOT NULL,last_seen_at TEXT,revoked_at TEXT);`);
    db.exec(`CREATE TABLE IF NOT EXISTS external_accounts (
      id TEXT PRIMARY KEY,provider TEXT NOT NULL,name TEXT NOT NULL,scope TEXT NOT NULL CHECK(scope IN ('PERSONAL','PROJECT')),
      owner_id TEXT NOT NULL REFERENCES users(id),project_id TEXT REFERENCES projects(id),base_url TEXT NOT NULL,auth_mode TEXT NOT NULL,credential TEXT NOT NULL,
      organization_id TEXT NOT NULL DEFAULT '',enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'CONFIGURED',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_checked_at TEXT,last_error TEXT,deleted_at TEXT,
      CHECK((scope='PERSONAL' AND project_id IS NULL) OR (scope='PROJECT' AND project_id IS NOT NULL)));
      CREATE INDEX IF NOT EXISTS account_owner_idx ON external_accounts(owner_id,provider);
      CREATE INDEX IF NOT EXISTS account_project_idx ON external_accounts(project_id,provider);
      CREATE TABLE IF NOT EXISTS account_preferences (
        user_id TEXT NOT NULL REFERENCES users(id),project_id TEXT NOT NULL REFERENCES projects(id),provider TEXT NOT NULL,account_id TEXT,
        updated_at TEXT NOT NULL,PRIMARY KEY(user_id,project_id,provider));
      CREATE TABLE IF NOT EXISTS account_external_imports (
        id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES external_accounts(id),resource TEXT NOT NULL,external_id TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id),kind TEXT NOT NULL,remote_version TEXT NOT NULL,content_hash TEXT NOT NULL,
        local_id TEXT NOT NULL REFERENCES assets(id),created_at TEXT NOT NULL,
        UNIQUE(account_id,resource,external_id,task_id,kind,remote_version,content_hash));
      CREATE TABLE IF NOT EXISTS project_workspaces (
        user_id TEXT NOT NULL REFERENCES users(id),project_id TEXT NOT NULL REFERENCES projects(id),repo_path TEXT NOT NULL,
        default_target TEXT NOT NULL DEFAULT 'workbench',updated_at TEXT NOT NULL,PRIMARY KEY(user_id,project_id));
      CREATE TABLE IF NOT EXISTS local_ai_runs (
        id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),project_id TEXT NOT NULL REFERENCES projects(id),
        job_id TEXT REFERENCES jobs(id),actor_id TEXT NOT NULL REFERENCES users(id),
        mode TEXT NOT NULL CHECK(mode IN ('read','develop','review')),engine TEXT NOT NULL,tool TEXT NOT NULL,
        repo_path TEXT,status TEXT NOT NULL,exit_code INTEGER,output TEXT NOT NULL DEFAULT '',draft_json TEXT,error TEXT,
        started_at TEXT NOT NULL,finished_at TEXT,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ai_run_task_idx ON local_ai_runs(task_id,started_at DESC);`);
    add('external_accounts', 'deleted_at', 'TEXT');
    add('local_ai_runs', 'runner', "TEXT NOT NULL DEFAULT 'local'");
    add('local_ai_runs', 'workbench_key', 'TEXT');
    add('local_ai_runs', 'model', 'TEXT');
    add('local_ai_runs', 'effective_model', 'TEXT');
    add('local_ai_runs', 'device_id', 'TEXT');
    add('local_ai_runs', 'phase', 'TEXT');
    add('local_ai_runs', 'lease_until', 'INTEGER');
    add('local_device_sessions', 'team_dispatch', 'INTEGER NOT NULL DEFAULT 0');
    add('local_device_sessions', 'model_engines', "TEXT NOT NULL DEFAULT '[]'");
    db.exec(`CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),owner_id TEXT NOT NULL REFERENCES users(id),assignee_id TEXT REFERENCES users(id),task_id TEXT REFERENCES tasks(id),
      title TEXT NOT NULL,details TEXT NOT NULL DEFAULT '',due_date TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','high')),status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','doing','done')),
      version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,source_id TEXT,UNIQUE(owner_id,source_id));
      CREATE INDEX IF NOT EXISTS todo_project_idx ON todos(project_id,status);
      CREATE INDEX IF NOT EXISTS todo_assignee_idx ON todos(assignee_id,status);`);
    add('local_ai_runs', 'cancel_requested', 'INTEGER NOT NULL DEFAULT 0');
    add('local_ai_runs', 'payload', 'TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS ai_run_device_idx ON local_ai_runs(device_id,status)');
    db.exec(`CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),project_id TEXT REFERENCES projects(id),task_id TEXT REFERENCES tasks(id),
      source TEXT NOT NULL,source_id TEXT NOT NULL,title TEXT NOT NULL,objective TEXT NOT NULL DEFAULT '',provider TEXT NOT NULL DEFAULT '',model TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT '',status TEXT NOT NULL,result TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',workspace TEXT NOT NULL DEFAULT '',branch TEXT NOT NULL DEFAULT '',
      turns INTEGER NOT NULL DEFAULT 0,input_tokens INTEGER NOT NULL DEFAULT 0,output_tokens INTEGER NOT NULL DEFAULT 0,cost_usd REAL NOT NULL DEFAULT 0,jira_keys TEXT NOT NULL DEFAULT '[]',
      shared INTEGER NOT NULL DEFAULT 0 CHECK(shared IN (0,1)),started_at TEXT NOT NULL,updated_at TEXT NOT NULL,synced_at TEXT NOT NULL,UNIQUE(owner_id,source,source_id));
      CREATE INDEX IF NOT EXISTS agent_session_owner_idx ON agent_sessions(owner_id,updated_at DESC);
      CREATE INDEX IF NOT EXISTS agent_session_project_idx ON agent_sessions(project_id,shared,updated_at DESC);
      CREATE TABLE IF NOT EXISTS agent_session_comments (id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES agent_sessions(id),author_id TEXT NOT NULL REFERENCES users(id),body TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_comment_session_idx ON agent_session_comments(session_id,created_at);
      CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),provider TEXT NOT NULL CHECK(provider IN ('manual','yunxiao','jenkins','other')),external_id TEXT,
      environment TEXT NOT NULL,service TEXT NOT NULL,version TEXT NOT NULL DEFAULT '',status TEXT NOT NULL CHECK(status IN ('running','success','failed','cancelled','unknown')),
      url TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',actor_id TEXT NOT NULL REFERENCES users(id),started_at TEXT NOT NULL,finished_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      UNIQUE(project_id,provider,external_id));
      CREATE INDEX IF NOT EXISTS deployment_project_idx ON deployments(project_id,started_at DESC);`);
    db.exec(`CREATE TABLE IF NOT EXISTS knowledge_docs (
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,body TEXT NOT NULL DEFAULT '',tags TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'manual',source_ref TEXT,version INTEGER NOT NULL DEFAULT 1,author_id TEXT NOT NULL REFERENCES users(id),updated_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(project_id,source_ref));
      CREATE INDEX IF NOT EXISTS knowledge_project_idx ON knowledge_docs(project_id,updated_at DESC);
      CREATE TABLE IF NOT EXISTS knowledge_revisions (id TEXT PRIMARY KEY,doc_id TEXT NOT NULL REFERENCES knowledge_docs(id),version INTEGER NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,tags TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS knowledge_revision_doc_idx ON knowledge_revisions(doc_id,version DESC);
      CREATE TABLE IF NOT EXISTS team_skills (
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),name TEXT NOT NULL,description TEXT NOT NULL,content TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),author_id TEXT NOT NULL REFERENCES users(id),updated_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      UNIQUE(project_id,name));
      CREATE TABLE IF NOT EXISTS team_skill_revisions (id TEXT PRIMARY KEY,skill_id TEXT NOT NULL REFERENCES team_skills(id),version INTEGER NOT NULL,description TEXT NOT NULL,content TEXT NOT NULL,enabled INTEGER NOT NULL,actor_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS skill_revision_idx ON team_skill_revisions(skill_id,version DESC);
      CREATE TABLE IF NOT EXISTS cloud_ai_configs (
        project_id TEXT PRIMARY KEY REFERENCES projects(id),
        provider_type TEXT NOT NULL CHECK(provider_type IN ('openai_compatible','dify')),
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        dify_mode TEXT NOT NULL DEFAULT 'workflow' CHECK(dify_mode IN ('workflow','chat')),
        credential TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
        auto_stages TEXT NOT NULL DEFAULT '[]',
        auto_writeback_mr INTEGER NOT NULL DEFAULT 0 CHECK(auto_writeback_mr IN (0,1)),
        timeout_ms INTEGER NOT NULL DEFAULT 60000,
        version INTEGER NOT NULL DEFAULT 1,
        updated_by TEXT NOT NULL REFERENCES users(id),
        updated_at TEXT NOT NULL,
        last_checked_at TEXT,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS project_webhooks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        provider TEXT NOT NULL CHECK(provider IN ('gitlab','confluence','generic')),
        name TEXT NOT NULL,
        secret TEXT NOT NULL,
        secret_preview TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
        auto_review INTEGER NOT NULL DEFAULT 1 CHECK(auto_review IN (0,1)),
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        last_triggered_at TEXT,
        last_status TEXT,
        last_message TEXT
      );
      CREATE INDEX IF NOT EXISTS webhook_project_idx ON project_webhooks(project_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS webhook_events (
        id TEXT PRIMARY KEY,
        webhook_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id),
        provider TEXT NOT NULL,
        event_type TEXT NOT NULL,
        task_id TEXT,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS webhook_event_project_idx ON webhook_events(project_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS project_im_webhooks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        channel TEXT NOT NULL CHECK(channel IN ('feishu','dingtalk','wecom','generic')),
        name TEXT NOT NULL,
        webhook_url TEXT NOT NULL,
        url_preview TEXT NOT NULL DEFAULT '',
        signing_secret TEXT,
        events TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        last_sent_at TEXT,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS im_webhook_project_idx ON project_im_webhooks(project_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS im_notification_logs (
        id TEXT PRIMARY KEY,
        im_webhook_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id),
        channel TEXT NOT NULL,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS im_log_project_idx ON im_notification_logs(project_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS mr_writebacks (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        project_id TEXT NOT NULL REFERENCES projects(id),
        asset_id TEXT NOT NULL,
        job_id TEXT NOT NULL REFERENCES jobs(id),
        provider TEXT NOT NULL,
        posted_count INTEGER NOT NULL DEFAULT 0,
        inline_count INTEGER NOT NULL DEFAULT 0,
        summary_posted INTEGER NOT NULL DEFAULT 0,
        actor_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('MANUAL','AUTO')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mr_writeback_task_idx ON mr_writebacks(task_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS personal_skills (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        owner_id TEXT NOT NULL REFERENCES users(id),
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        content TEXT NOT NULL,
        scopes TEXT NOT NULL DEFAULT '[]',
        files TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT 'manual',
        version INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id,owner_id,name)
      );
      CREATE INDEX IF NOT EXISTS personal_skill_owner_idx ON personal_skills(project_id,owner_id,name);`);
    add('reports', 'verdict', 'TEXT'); add('reports', 'score', 'INTEGER'); add('reports', 'checklist', 'TEXT');
    add('reports', 'meta', 'TEXT');
    add('findings', 'category', 'TEXT'); add('findings', 'confidence', 'INTEGER'); add('findings', 'rule_id', 'TEXT'); add('findings', 'patch_json', 'TEXT');
    add('local_ai_runs', 'action_type', 'TEXT');
    add('team_skills', 'scopes', "TEXT NOT NULL DEFAULT '[]'");
    add('team_skills', 'files', "TEXT NOT NULL DEFAULT '[]'");
    add('team_skills', 'source', "TEXT NOT NULL DEFAULT 'manual'");
    add('team_skill_revisions', 'scopes', "TEXT NOT NULL DEFAULT '[]'");
    add('team_skill_revisions', 'files', "TEXT NOT NULL DEFAULT '[]'");
    db.exec(`CREATE TABLE IF NOT EXISTS skill_catalog (
      id TEXT PRIMARY KEY,source_project_id TEXT,owner_id TEXT NOT NULL REFERENCES users(id),
      visibility TEXT NOT NULL CHECK(visibility IN ('TEAM','PERSONAL')),
      name TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,content TEXT NOT NULL,
      scopes TEXT NOT NULL DEFAULT '[]',files TEXT NOT NULL DEFAULT '[]',source TEXT NOT NULL DEFAULT 'manual',
      version INTEGER NOT NULL DEFAULT 1,enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      updated_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS skill_catalog_revisions (
      id TEXT PRIMARY KEY,skill_id TEXT NOT NULL REFERENCES skill_catalog(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,content TEXT NOT NULL,
      scopes TEXT NOT NULL,files TEXT NOT NULL,enabled INTEGER NOT NULL,
      actor_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,
      UNIQUE(skill_id,version)
    );
    CREATE TABLE IF NOT EXISTS project_skill_links (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      skill_id TEXT NOT NULL REFERENCES skill_catalog(id) ON DELETE CASCADE,
      PRIMARY KEY(project_id,skill_id)
    );
    CREATE INDEX IF NOT EXISTS project_skill_links_skill_idx ON project_skill_links(skill_id,project_id);`);
    if (!db.prepare('SELECT version FROM schema_migrations WHERE version=7').get()) {
      db.exec(`INSERT INTO skill_catalog (id,source_project_id,owner_id,visibility,name,title,description,content,scopes,files,source,version,enabled,updated_by,created_at,updated_at)
        SELECT id,project_id,author_id,'TEAM',name,name,description,content,scopes,files,source,version,enabled,updated_by,created_at,updated_at FROM team_skills;
        INSERT INTO skill_catalog (id,source_project_id,owner_id,visibility,name,title,description,content,scopes,files,source,version,enabled,updated_by,created_at,updated_at)
        SELECT id,project_id,owner_id,'PERSONAL',name,name,description,content,scopes,files,source,version,enabled,owner_id,created_at,updated_at FROM personal_skills;
        INSERT INTO project_skill_links (project_id,skill_id)
        SELECT source_project_id,id FROM skill_catalog WHERE source_project_id IS NOT NULL;
        INSERT INTO skill_catalog_revisions (id,skill_id,version,title,description,content,scopes,files,enabled,actor_id,created_at)
        SELECT r.id,r.skill_id,r.version,s.name,r.description,r.content,r.scopes,r.files,r.enabled,r.actor_id,r.created_at
        FROM team_skill_revisions r JOIN team_skills s ON s.id=r.skill_id;`);
      db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(7, new Date().toISOString());
    }
    const interruptedAt = new Date().toISOString();
    db.prepare("UPDATE local_ai_runs SET status='INTERRUPTED',error='服务重启，本地执行已中断',finished_at=?,updated_at=? WHERE status='RUNNING' AND runner='local'").run(interruptedAt, interruptedAt);
    db.prepare('INSERT OR IGNORE INTO projects VALUES (?,?,?,?)').run('default', 'DEFAULT', '默认项目', new Date().toISOString());
    if (migrate) {
      db.exec("UPDATE tasks SET assignee_id=owner_id; UPDATE audit SET project_id='default';");
      for (const user of db.prepare('SELECT id,role FROM users').all()) db.prepare('INSERT OR IGNORE INTO project_members VALUES (?,?,?)').run('default', user.id, user.role === 'ADMIN' ? 'LEAD' : user.role);
      db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(1, new Date().toISOString());
    }
    db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES (?,?)').run(2, new Date().toISOString());
    db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES (?,?)').run(3, new Date().toISOString());
    db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES (?,?)').run(4, new Date().toISOString());
    db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES (?,?)').run(5, new Date().toISOString());
    db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES (?,?)').run(6, new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  return db;
}
