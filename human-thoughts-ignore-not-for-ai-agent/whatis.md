

- dashboard checklist 
    - what is the checklist meaning each point and for what, items are: 
        - reporting period verified 
        - snapshot metrics reviewed 
        - distributed constraints acknowledged 
        - export scope confirmed
    - stat cards, what is: 
        - gross volume 
        - success rate
        - open action queues (approvals + operator cases)
        - unknown backlog
    - for the payments attempts charts what is the difference between volume  andd attempts by state
    - how is routes health measured, 
    - what is approve queue by domain, what does each mean
    - what is Recent privileged activity

- dashboard success rate (successRate=attempts_success_count/total_attempts_count*100) metrice needs to be fixed, the total count must not include pending attempts such as created also not include states that are cancelled or expired since its ourt decision and not failure to process payment, the main total count should include problematic attempts + succeeded attempts, i leave the decision up to you  