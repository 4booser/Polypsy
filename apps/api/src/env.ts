export const env = {
  port: Number(process.env.PORT ?? 3001),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://postgres@localhost:5432/quizzy",
  jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-me",
};

if (process.env.NODE_ENV === "production" && env.jwtSecret === "dev-secret-change-me") {
  throw new Error("JWT_SECRET must be set in production");
}
