R --vanilla <<EOF
jpeg("doc/perf1.jpg", width=400, height=300)
barplot(
  c(1122000,182000),
  main="Read-transform-write operations per second",
  names.arg=c("simple-streams","nodejs webstreams"),
  yaxt="n"
  )
axis(2, axTicks(2), format(axTicks(2), scientific = F))
EOF
