import { testDatabaseUrl } from "./load-env";

// Point Prisma at the disposable test database before any module creates a client.
process.env.DATABASE_URL = testDatabaseUrl();
process.env.APP_URL = "http://localhost:3000";
