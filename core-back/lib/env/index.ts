import z from "zod"; 


const envSchema = z.object({
    DATABASE_HOST: z.string().default("localhost"),
    DATABASE_URL: z.string().default("mysql://admin:admin@localhost:3306/deletion-requests"), 
    DATABASE_USER: z.string().default("admin"), 
    DATABASE_PASSWORD: z.string().default("admin"), 
    DATABASE_NAME: z.string().default("deletion-requests"), 


    PORT: z.coerce.number().default(3003),
})

const result = await z.safeParseAsync(envSchema, process.env)
if(!result.success){
    console.error("invalid environement", result.error)
    process.exit(1)
}

export const env = result.data; 
