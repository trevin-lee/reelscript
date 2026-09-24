import { createServer } from "./server.js";
import { projects } from "./projects.js";

const server = createServer();

server.get("/projects", () => projects.list());

server.listen(3000, () => {
  console.log("acme listening on http://localhost:3000");
});
