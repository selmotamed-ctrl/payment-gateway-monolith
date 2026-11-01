
this project is a monolith for a payment gateway 

please read the design files in ./design directory: 
    - design/payment_gateway_final_design-v5.md
    - design/payment-gateway-refined-design-v4.1.md
    - design/smart_ai_rail_and_voucher_onboarding_plan.md
    - design/payment_gateway_deployment_and_guides_architecture.md
    - design/Dynamic-Payment-Gateway-Management-Design-v2.md
    - design/opencode_technical_delivery_design.md

to understand the project read the design files, also, please read the schema at core-back/prisma/schema.prisma


the page http://localhost:8443/operator-cases in admin front is not suitable and need fixing, its not according to the design
  - the bulk inquiry is not working and should be redesigned properly
  - the table filters are not suitable, they are missing filter by searching filter + search by merchant name and case reference
  - the column attempts in the table shows a checkbox??? fix the columns show what is proper with as much details as possible, 
  - create a case details page that can be opened from the case row that shows all details and actions regarding a case according to the design (READ the design, source code, and guide to understand the proper structure and details)
  
investigate, plan very carefully, and then lets implement