import { migration001 } from "./001-init";
import { migration002 } from "./002-sync";
import { migration003 } from "./003-write-path";
import { migration004 } from "./004-admin";
import { migration005 } from "./005-changes-feed";
import { migration006 } from "./006-multi-seat";

export const LOCAL_MIGRATIONS: { version: number; sql: string }[] = [
  { version: 1, sql: migration001 },
  { version: 2, sql: migration002 },
  { version: 3, sql: migration003 },
  { version: 4, sql: migration004 },
  { version: 5, sql: migration005 },
  { version: 6, sql: migration006 },
];
