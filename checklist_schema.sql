/* -----------------------------------------------------------
   1.  CREATE DATABASE   (feel free to change charset / collation)
----------------------------------------------------------- */
CREATE DATABASE IF NOT EXISTS shiftcheck
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;
USE shiftcheck;

/* -----------------------------------------------------------
   2.  TABLES
----------------------------------------------------------- */

/* ---- employees ------------------------------------------ */
CREATE TABLE employees (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name            VARCHAR(100)      NOT NULL,
  pin_hash        CHAR(60)          NOT NULL,
  role            ENUM('employee','viewer','admin') NOT NULL DEFAULT 'employee',
  last_login_ip   VARCHAR(45),
  last_login_loc  VARCHAR(255),
  theme_preference ENUM('light','dark') NOT NULL DEFAULT 'light',
  failed_attempts INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Consecutive failed login attempts',
  is_locked       TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = Account locked due to failed attempts'
) ENGINE=InnoDB;

/* ---- categories --------------------------------------- */
CREATE TABLE categories (
  id   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  sort_order INT UNSIGNED NOT NULL DEFAULT 0
) ENGINE=InnoDB;

-- Add index for sort_order
ALTER TABLE categories ADD INDEX idx_sort_order (sort_order);

/* ---- tasks ---------------------------------------------- */
CREATE TABLE tasks (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title           VARCHAR(255)      NOT NULL,
  description     TEXT,
  category_id     INT UNSIGNED      NOT NULL,
  tolerance_hours INT               NOT NULL DEFAULT 24,
  no_timeout      TINYINT(1)        NOT NULL DEFAULT 0 COMMENT '1 = never turns red',
  sort_order      INT UNSIGNED      NOT NULL DEFAULT 0,
  CONSTRAINT fk_task_cat
        FOREIGN KEY (category_id) REFERENCES categories(id)
        ON DELETE RESTRICT
) ENGINE=InnoDB;

-- Add index for category_id and sort_order
ALTER TABLE tasks ADD INDEX idx_category_sort (category_id, sort_order);

/* ---- task_assignments  (M‑to‑M join) -------------------- */
CREATE TABLE task_assignments (
  employee_id INT UNSIGNED NOT NULL,
  task_id     INT UNSIGNED NOT NULL,
  PRIMARY KEY (employee_id, task_id),
  CONSTRAINT fk_ta_emp FOREIGN KEY (employee_id) REFERENCES employees(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_ta_task FOREIGN KEY (task_id)     REFERENCES tasks(id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

/* ---- task_logs ------------------------------------------ */
CREATE TABLE task_logs (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  task_id       INT UNSIGNED NOT NULL,
  employee_id   INT UNSIGNED NOT NULL,
  completed_at  DATETIME     NOT NULL,
  ip            VARCHAR(45),
  location      VARCHAR(255),
  display_name  VARCHAR(100),
  CONSTRAINT fk_log_task FOREIGN KEY (task_id)     REFERENCES tasks(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_log_emp  FOREIGN KEY (employee_id) REFERENCES employees(id)
    ON DELETE CASCADE,
  INDEX emp_time (employee_id, completed_at)               -- speeds stats queries
) ENGINE=InnoDB;

/* ---- checkouts ------------------------------------------ */
CREATE TABLE checkouts (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  employee_id    INT UNSIGNED NOT NULL,
  checkout_at    DATETIME     NOT NULL,
  ip             VARCHAR(45),
  location       VARCHAR(255),
  checklist_json JSON,
  CONSTRAINT fk_co_emp FOREIGN KEY (employee_id) REFERENCES employees(id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

/* ---- comments ------------------------------------------- */
CREATE TABLE comments (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  task_id       INT UNSIGNED NOT NULL,
  employee_id   INT UNSIGNED NOT NULL,
  comment_text  TEXT NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_comment_task FOREIGN KEY (task_id) REFERENCES tasks(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_comment_emp FOREIGN KEY (employee_id) REFERENCES employees(id)
    ON DELETE CASCADE,
  INDEX idx_comment_task_time (task_id, created_at)
) ENGINE=InnoDB;

/* ---- category_assignments  (M-to-M Employee ⇄ Category) */
CREATE TABLE category_assignments (
  category_id INT UNSIGNED NOT NULL,
  employee_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (category_id, employee_id),
  CONSTRAINT fk_ca_cat FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
  CONSTRAINT fk_ca_emp FOREIGN KEY (employee_id) REFERENCES employees(id)  ON DELETE CASCADE
) ENGINE=InnoDB;

/* No accounts are seeded. Create the first admin with:  cd server && npm run create-admin */
