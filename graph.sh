cat | R --vanilla <<EOF
jpeg("doc/perf1.jpg", width=400, height=300)
barplot(c(287000,185000),main="Read-transform-write operations per second",names.arg=c("simple-streams","nodejs webstreams"))
EOF
