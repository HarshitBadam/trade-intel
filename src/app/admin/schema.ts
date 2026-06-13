import { z } from "zod";

export const formSchema = z.object({
  ticker: z.string().min(1).max(5).toUpperCase(),
  company: z.string().min(1).max(100),
  // Restrict to http(s) so dangerous schemes (javascript:, data:) can't be
  // stored and later rendered as an href/src (stored-XSS surface).
  logo: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), {
      message: "Logo must be an http(s) URL.",
    }),
});

export type CompanyForm = z.infer<typeof formSchema>;
