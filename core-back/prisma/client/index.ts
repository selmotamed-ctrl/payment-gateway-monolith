import { REQUIRED_SCHEMA_VERSION } from "../schemaVersion";
import { baseClient } from "./base";

const client = baseClient; 
await client.$connect()

const schemaVersion = await client.schemaVersion.findFirstOrThrow({
    where: {
        id: 1, 
    }
})

if(schemaVersion.version != REQUIRED_SCHEMA_VERSION){
    console.error("Binary Schema Version does not match database schema version")
    process.exit(1); 
}

type TransactionCallback = Parameters<typeof client.$transaction>[0];
export type CtxClient = TransactionCallback extends (tx: infer T, ...args: any[]) => any ? T : never;

export {client}