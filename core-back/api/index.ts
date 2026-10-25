import express from "express"; 
import { publicRouter } from "./public";

const router = express.Router(); 


router.use("/public", publicRouter)

export const apiRouter = router; 