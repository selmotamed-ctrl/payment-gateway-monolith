1. Default synthetic profile: demo (recommended) or staging?
1.a: go with the recommended 

2. Fake rail architecture: embedded loopback provider (recommended) or standalone public fake-provider service?
2.a: go with the recommended, the embedded loopback providers, the ones we are going to create for testing

3. Include the redirect rail with a fake checkout page, or limit the first version to OTP + QR + push?
3.a: include the redirect rail with a fake checkout page

4. Should synthetic data run automatically from deploy.env (RUN_SYNTHETIC_SEED=true) or only manually via bun run seed-synthetic?
4.a include both options, make it smart to recognize if the synthetic data has been already populated if you did not plan that already 


5. Should the current test server, which runs NODE_ENV=production, allow synthetic data and fake rails with explicit opt-in flags
5.a yes