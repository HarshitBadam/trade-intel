import { z } from "zod";



export const formSchema = z.object({
  ticker: z.string().min(1).max(5).toUpperCase(),
  company: z.string().min(1).max(100),
  logo: z.string().url(),
});

export async function postCompany(data: z.infer<typeof formSchema>) {

}
