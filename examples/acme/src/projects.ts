export interface Project {
  id: string;
  name: string;
  status: "live" | "draft";
}

const store: Project[] = [
  { id: "p1", name: "Website redesign", status: "live" },
  { id: "p2", name: "Mobile onboarding", status: "live" },
  { id: "p3", name: "Billing v2", status: "draft" },
];

export const projects = {
  list: () => store,
  create: (name: string): Project => {
    const project: Project = { id: `p${store.length + 1}`, name, status: "draft" };
    store.unshift(project);
    return project;
  },
};
