
the reporting system needs bit of fixing especially in the generated reports 
i have built a quite long and all feature including report spec and made a sample pdf report with it

the spec in: /home/salem/report-spec-generator/src/provided-sample-reports-and-spec/npg-ops-finance-deep-dive-showcase-v2.json

the pdf sample: /home/salem/report-spec-generator/src/provided-sample-reports-and-spec/Libyan National Payment Gateway — Operations & Finance Deep Dive.pdf


there is some problems in the pdf report on some pages

- page 1 "Headline Metrics" the cards are broken, you place 5 per row, maximum should be 3 per row, in addition the numbers are over flowing the card, also, the numbers and titles are not equal in height for each card which cause the cards to not look good for example the card title should be attached to top of the card and the number attached to the bottom of the card always, also the number font size should be reduced to allow large numbers (do deep research and enhance o n it)

- page 1 and page 2: "Operational Health", shows an important example of how a section title got separated from its content, the title "Operational Health" is in page 1, and content is in page 2


- page 2 "Attempts by Outcome", the pie chart (and charts in general) if its alone in the row (there is nothing beside it), it should be centered, the idea even if there is two charts side by side they should be centered 

- page 2 "Attempts by Outcome", the pie chart and its colored caption description (the lower part of the chart that describe what each color means) should has gap between them they have like 0px between them at least there should be comfortable spacing between them, and the chart and describe captions should always be in the same page, also, this problem shown in the chart of "Volume by Outcome", one more thing, the charts that has titled section should have small descriptive text ( a small paragraph after the title and before the chart) this should be asked by the transcript from the spec generating AI (it should be added to the transcript instruction) this not just important for charts even for tables

- page 3 "Status vs TargetBaseline" table, the table cell font should be decreased a little bit, its too large, and the cell content for wide tables look crammed, same for table headers, also tables that extends for multiple pages, should repeat their headers so the reader does not have to go back and read what that column means, also, chips for column one of that table some of them breaks words (which there is no way to avoid it in some cases) however there should be a solution for this for example reducing the font size for chips 

- page 5: "Weekly Net Movement" chart should follow the center rule if it wont take the entire width of the paper

- page 6: "Hourly Load (Last 3 Days)" chart has no data, it looks weird, there should be a clarification that there is no data for this chart 

- page 16: "Latest Settled Attempts" table over flows from the page side (for english the right side of the page), the page should prevent overflow withing givin good looking padding, in addition overflows in general should be fixed completely any report part should contain it self with the page boundaries, also maybe due to the table being broken/overflowing the page footer is not at the bottom of the page and it cuts around 70% of the page height instead of showing the rest of the table and the table continues in the next page, 


- page 23: "Reconciliation Outcomes" the chart overlap with its caption/describe sections that clarifies what each color means, there should always be separated even if they take more height, also all charts preferably should be in one row taking the whole width of the page, unless clearly instructed by the system that two charts in one row, also chart caption/font size should reduced a lot


- page 26, "Settlement Waterfall" a block of this chart should always have proper padding to contain its text for example the block 1 "Gross" has the number value "41,135,720.764 LYD" touches the block borders, same for the last block "Net To Merchant"

page 30-31, "Methodology & Notes" a section/part like this should properly displayed by either moving wholly to the next page or be properly sized, also the font size is large it need to be reduced a little bit

please investigate each of these, find the root cause for each, find any similar problems in the report that need to be fixed, build a very comprehensive and well researched plan



